/**
 * Scheduler service — cron-style background jobs for the D2R 1v1 League bot.
 *
 * Jobs:
 *   1. Match cadence check (every 4 hours)
 *      - Finds ACTIVE players whose lastMatchAt is null or older than MATCH_CADENCE_DAYS.
 *      - For those without an existing forced assignment, issues a forced match ping.
 *
 *   2. Warning escalation (every 4 hours, offset by 30 minutes)
 *      - Finds players with a forced match assignment older than 24 hours.
 *      - Issues a warning (and auto-removes at threshold).
 *
 *   3. Leaderboard embed refresh (every hour)
 *      - Edits the pinned #1v1-leaderboard embed to reflect current standings.
 *      - Covers cases where manual sheet edits change rankings between matches.
 */

import type { Client, TextChannel } from 'discord.js';
import { EmbedBuilder, Colors } from 'discord.js';
import { prisma } from '../db/client.js';
import { getForcedMatch, setForcedMatch, clearForcedMatch } from './queue.js';
import { updateLeaderboardEmbed } from './leaderboardEmbed.js';
import { CHANNELS } from '../config/channels.js';
import { config } from '../config.js';

const FOUR_HOURS_MS  = 4 * 60 * 60 * 1000;
const ONE_HOUR_MS    = 60 * 60 * 1000;
const WARNING_DELAY_MS = 24 * 60 * 60 * 1000;  // 24h after forced assignment before warning

// ── Start ─────────────────────────────────────────────────────────────────────

/**
 * Starts the scheduler. Must be called after the Discord client is ready.
 */
export function startScheduler(client: Client): void {
  console.log('[Scheduler] Starting...');

  // Run cadence check shortly after boot, then every 4 hours
  setTimeout(() => runCadenceCheck(client), 2 * 60 * 1000);
  setInterval(() => runCadenceCheck(client), FOUR_HOURS_MS);

  // Run warning escalation offset by 30 minutes, then every 4 hours
  setTimeout(() => runWarningEscalation(client), 32 * 60 * 1000);
  setInterval(() => runWarningEscalation(client), FOUR_HOURS_MS);

  // Refresh the leaderboard embed every hour (covers manual sheet edits between matches)
  setInterval(() => updateLeaderboardEmbed(client).catch((e) =>
    console.error('[Scheduler] Leaderboard refresh failed:', e)
  ), ONE_HOUR_MS);

  console.log('[Scheduler] Jobs scheduled.');
}

// ── Job 1: Match cadence check ────────────────────────────────────────────────

async function runCadenceCheck(client: Client): Promise<void> {
  console.log('[Scheduler] Running match cadence check...');

  try {
    const season = await prisma.season.findFirst({ where: { active: true } });
    if (!season) return;

    const cadenceMs = config.league.matchCadenceDays * 24 * 60 * 60 * 1000;
    const cutoff = new Date(Date.now() - cadenceMs);

    // Find all ACTIVE players whose last match was before the cutoff (or never)
    const overduePlayers = await prisma.player.findMany({
      where: {
        seasonId: season.id,
        status: 'ACTIVE',
        OR: [
          { lastMatchAt: null },
          { lastMatchAt: { lt: cutoff } },
        ],
      },
      select: { discordId: true, discordUsername: true },
    });

    if (overduePlayers.length === 0) {
      console.log('[Scheduler] Cadence check: no overdue players.');
      return;
    }

    const queueChannel = client.channels.cache.get(CHANNELS.queue) as TextChannel | undefined;
    let newlyNotified = 0;

    for (const player of overduePlayers) {
      // Skip if they already have a forced assignment
      const existing = await getForcedMatch(player.discordId);
      if (existing) continue;

      // Issue the forced match assignment
      await setForcedMatch(player.discordId, { assignedAt: Date.now() });
      newlyNotified++;

      // Ping them in #1v1-queue
      if (queueChannel) {
        await queueChannel.send({
          content: `<@${player.discordId}>`,
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Yellow)
              .setTitle('Forced Match Assignment')
              .setDescription(
                `<@${player.discordId}>, it's been more than **${config.league.matchCadenceDays} days** since your last match.\n\n` +
                `You are required to play. Run \`/im-ready\` to acknowledge and enter the queue.\n\n` +
                `Failing to respond within **24 hours** will result in a warning.`
              )
              .setTimestamp(),
          ],
        });
      }
    }

    console.log(`[Scheduler] Cadence check: ${newlyNotified} player(s) notified out of ${overduePlayers.length} overdue.`);
  } catch (err) {
    console.error('[Scheduler] Cadence check error:', err);
  }
}

// ── Job 2: Warning escalation ─────────────────────────────────────────────────

async function runWarningEscalation(client: Client): Promise<void> {
  console.log('[Scheduler] Running warning escalation check...');

  try {
    const season = await prisma.season.findFirst({ where: { active: true } });
    if (!season) return;

    const activePlayers = await prisma.player.findMany({
      where: { seasonId: season.id, status: 'ACTIVE' },
      select: { id: true, discordId: true, discordUsername: true, warnings: true },
    });

    const threshold = config.league.warningThreshold;
    let warningsIssued = 0;

    for (const player of activePlayers) {
      const forced = await getForcedMatch(player.discordId);
      if (!forced) continue;

      // Check if the assignment is older than WARNING_DELAY_MS
      if (Date.now() - forced.assignedAt < WARNING_DELAY_MS) continue;

      // Issue a warning
      const newWarningCount = player.warnings + 1;
      const autoRemove = newWarningCount >= threshold;

      await prisma.$transaction([
        prisma.warning.create({
          data: {
            playerId: player.id,
            reason: `Unresponsive to forced match assignment (overdue ${config.league.matchCadenceDays}+ days)`,
            issuedBy: 'system',
          },
        }),
        prisma.player.update({
          where: { id: player.id },
          data: {
            warnings: newWarningCount,
            ...(autoRemove ? { status: 'REMOVED' } : {}),
          },
        }),
      ]);

      // Clear the forced match assignment so they can be re-evaluated next cycle
      await clearForcedMatch(player.discordId);

      warningsIssued++;

      // Log to mod-logs
      const logChannel = client.channels.cache.get(CHANNELS.modLogs) as TextChannel | undefined;
      if (logChannel) {
        await logChannel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(autoRemove ? Colors.Red : Colors.Orange)
              .setTitle(autoRemove ? 'Player Auto-Removed (Warning Threshold)' : 'Auto-Warning Issued')
              .setDescription(
                `<@${player.discordId}> failed to acknowledge a forced match assignment.\n\n` +
                `**Warnings:** ${newWarningCount}/${threshold}` +
                (autoRemove ? '\n\n**Player has been automatically removed from the ladder.**' : '')
              )
              .setFooter({ text: 'Issued by system scheduler' })
              .setTimestamp(),
          ],
        });
      }

      // Notify the player in #1v1-queue
      const queueChannel = client.channels.cache.get(CHANNELS.queue) as TextChannel | undefined;
      if (queueChannel) {
        await queueChannel.send({
          content: `<@${player.discordId}>`,
          embeds: [
            new EmbedBuilder()
              .setColor(autoRemove ? Colors.Red : Colors.Orange)
              .setTitle(autoRemove ? 'Removed from Ladder' : `Warning Issued (${newWarningCount}/${threshold})`)
              .setDescription(
                autoRemove
                  ? `<@${player.discordId}>, you have been removed from the ladder for failing to respond to a forced match assignment. Contact a mod if you believe this is in error.`
                  : `<@${player.discordId}>, you've received a warning for failing to respond to your forced match assignment. You now have **${newWarningCount}/${threshold}** warnings.`
              )
              .setTimestamp(),
          ],
        });
      }
    }

    console.log(`[Scheduler] Warning escalation: ${warningsIssued} warning(s) issued.`);
  } catch (err) {
    console.error('[Scheduler] Warning escalation error:', err);
  }
}
