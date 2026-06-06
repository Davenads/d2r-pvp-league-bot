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
 *
 *   8. State reconciliation (every 4 hours, offset by 110 minutes)
 *      - Finds ACTIVE players marked in_match with no active match SET entries.
 *      - These are orphaned from the all-banned flow if players never clicked Override/Re-queue.
 *      - Resets their state to idle and logs to mod-ops.
 */

import type { Client, TextChannel } from 'discord.js';
import { EmbedBuilder, Colors, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } from 'discord.js';
import type { ThreadChannel } from 'discord.js';
import { prisma } from '../db/client.js';
import { getForcedMatch, setForcedMatch, clearForcedMatch, setForcedMatchThread, getQueueList, getPlayerState, setPlayerState, hasActiveMatches } from './queue.js';
import { updateLeaderboardEmbed } from './leaderboardEmbed.js';
import { resolveMatchByReadyCheck } from './readyCheck.js';
import { CHANNELS } from '../config/channels.js';
import { ROLES } from '../config/roles.js';
import { config } from '../config.js';

const FOUR_HOURS_MS         = 4 * 60 * 60 * 1000;
const ONE_HOUR_MS           = 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS  = 24 * 60 * 60 * 1000;
const THREE_DAYS_MS         = 3 * TWENTY_FOUR_HOURS_MS;
const WARNING_DELAY_MS      = TWENTY_FOUR_HOURS_MS;  // 24h after forced assignment before warning
const THREAD_ARCHIVE_DELAY_MS = TWENTY_FOUR_HOURS_MS;  // 24h after confirmation before auto-archive (scheduler fallback)
const MATCH_REMINDER_DELAY_MS = TWENTY_FOUR_HOURS_MS;  // 24h before reminding players in thread

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

  // Refresh the leaderboard embed shortly after boot, then every hour
  setTimeout(() => updateLeaderboardEmbed(client).catch((e) =>
    console.error('[Scheduler] Leaderboard boot refresh failed:', e)
  ), 30 * 1000);
  setInterval(() => updateLeaderboardEmbed(client).catch((e) =>
    console.error('[Scheduler] Leaderboard refresh failed:', e)
  ), ONE_HOUR_MS);

  // Run thread cleanup every 4 hours (offset by 60 minutes)
  setTimeout(() => runThreadCleanup(client), 60 * 60 * 1000);
  setInterval(() => runThreadCleanup(client), FOUR_HOURS_MS);

  // Run warning decay every 4 hours (offset by 90 minutes)
  setTimeout(() => runWarningDecay(client), 90 * 60 * 1000);
  setInterval(() => runWarningDecay(client), FOUR_HOURS_MS);

  // Run match reminder every 24 hours (offset by 2 hours to spread load)
  setTimeout(() => runMatchReminder(client), 2 * 60 * 60 * 1000);
  setInterval(() => runMatchReminder(client), TWENTY_FOUR_HOURS_MS);

  // Run ready check deadline resolution every hour (offset by 45 minutes to spread load)
  setTimeout(() => runReadyCheckDeadlines(client), 45 * 60 * 1000);
  setInterval(() => runReadyCheckDeadlines(client), ONE_HOUR_MS);

  // Queue nudge: fire at 22:00 UTC (6 PM EST) and 02:00 UTC (10 PM EST) daily
  scheduleDaily(22, 0, () => runQueueNudge(client));
  scheduleDaily(2,  0, () => runQueueNudge(client));

  // Run state reconciliation every 4 hours (offset by 110 minutes to spread load)
  setTimeout(() => runStateReconciliation(client), 110 * 60 * 1000);
  setInterval(() => runStateReconciliation(client), FOUR_HOURS_MS);

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

    // Find all ACTIVE players whose last match was before the cutoff,
    // or who have never played but registered long enough ago to be considered overdue.
    const overduePlayers = await prisma.player.findMany({
      where: {
        seasonId: season.id,
        status: 'ACTIVE',
        OR: [
          { lastMatchAt: { lt: cutoff } },
          { lastMatchAt: null, registeredAt: { lt: cutoff } },
        ],
      },
      select: { discordId: true, discordUsername: true },
    });

    if (overduePlayers.length === 0) {
      console.log('[Scheduler] Cadence check: no overdue players.');
      return;
    }

    const resultsChannel = client.channels.cache.get(CHANNELS.matchResults) as TextChannel | undefined;
    let newlyNotified = 0;

    for (const player of overduePlayers) {
      // Skip if they already have a forced assignment
      const existing = await getForcedMatch(player.discordId);
      if (existing) continue;

      // Issue the forced match assignment
      await setForcedMatch(player.discordId, { assignedAt: Date.now() });
      newlyNotified++;

      const assignmentEmbed = new EmbedBuilder()
        .setColor(Colors.Yellow)
        .setTitle('Forced Match Assignment')
        .setDescription(
          `<@${player.discordId}>, it's been more than **${config.league.matchCadenceDays} days** since your last match.\n\n` +
          `You are required to play. Click the button below or run \`/queue\` to enter the queue — this will acknowledge your assignment.\n\n` +
          `Failing to respond within **24 hours** will result in a warning.`
        )
        .setTimestamp();

      const queueRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('queue_join')
          .setLabel('⚔️ Join Queue')
          .setStyle(ButtonStyle.Primary)
      );

      // Ping in #1v1-match-results
      if (resultsChannel) {
        await resultsChannel.send({
          content: `<@${player.discordId}>`,
          embeds: [assignmentEmbed],
          components: [queueRow],
        });
      }

      // Also DM the player so they can't miss it (B3)
      try {
        const user = await client.users.fetch(player.discordId);
        await user.send({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Yellow)
              .setTitle('D2R 1v1 League — Forced Match Assignment')
              .setDescription(
                `It's been more than **${config.league.matchCadenceDays} days** since your last match.\n\n` +
                `Head to the queue channel and use \`/queue\` to enter — this will acknowledge your assignment.\n\n` +
                `Failing to respond within **24 hours** will result in a warning.`
              )
              .setTimestamp(),
          ],
        });
      } catch {
        // DMs may be closed — queue channel post is the fallback
      }

      // Create a private notification thread for this player (H1)
      const threadParent = client.channels.cache.get(CHANNELS.matchThreads) as TextChannel | undefined;
      if (threadParent) {
        try {
          const thread = await threadParent.threads.create({
            name: `Forced Assignment: ${player.discordUsername}`,
            type: ChannelType.PrivateThread,
            reason: `Forced match cadence notification for ${player.discordUsername}`,
          }) as ThreadChannel;

          await thread.members.add(player.discordId);

          // Add all mods
          const guild = client.guilds.cache.first();
          if (guild) {
            const modRole = guild.roles.cache.get(ROLES.mod)
              ?? await guild.roles.fetch(ROLES.mod).catch(() => null);
            if (modRole) {
              for (const [modId] of modRole.members) {
                await thread.members.add(modId).catch(() => {
                  console.warn(`[Scheduler] Could not add mod ${modId} to forced-assignment thread`);
                });
              }
            }
          }

          await thread.send({
            content: `<@${player.discordId}>`,
            embeds: [
              new EmbedBuilder()
                .setColor(Colors.Yellow)
                .setTitle('Forced Match Assignment')
                .setDescription(
                  `<@${player.discordId}>, it's been more than **${config.league.matchCadenceDays} days** since your last match.\n\n` +
                  `You are required to play. Click the button below or run \`/queue\` to enter the queue — this will acknowledge your assignment.\n\n` +
                  `Failing to respond within **24 hours** will result in a warning.`
                )
                .setTimestamp(),
            ],
            components: [queueRow],
          });

          // Store thread ID so queueJoin can archive it when the player queues
          await setForcedMatchThread(player.discordId, thread.id);
        } catch (threadErr) {
          console.warn(`[Scheduler] Failed to create forced-assignment thread for ${player.discordUsername}:`, threadErr);
        }
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
            ...(autoRemove ? { status: 'REMOVED', removedAt: new Date() } : {}),
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

      // Notify the player in #1v1-match-results
      const resultsChannel2 = client.channels.cache.get(CHANNELS.matchResults) as TextChannel | undefined;
      if (resultsChannel2) {
        await resultsChannel2.send({
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

// ── Job 3: Warning decay ──────────────────────────────────────────────────────

/**
 * Resets warnings to 0 for any ACTIVE player who has had a confirmed match on each
 * of the last 3 consecutive calendar days (UTC). Signals consistent re-engagement.
 */
async function runWarningDecay(client: Client): Promise<void> {
  console.log('[Scheduler] Running warning decay check...');

  try {
    const season = await prisma.season.findFirst({ where: { active: true } });
    if (!season) return;

    const playersWithWarnings = await prisma.player.findMany({
      where: { seasonId: season.id, status: 'ACTIVE', warnings: { gt: 0 } },
      select: { id: true, discordId: true, warnings: true },
    });

    if (playersWithWarnings.length === 0) {
      console.log('[Scheduler] Warning decay: no players with warnings.');
      return;
    }

    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    let decayed = 0;

    for (const player of playersWithWarnings) {
      const recentMatches = await prisma.match.findMany({
        where: {
          OR: [{ player1Id: player.id }, { player2Id: player.id }],
          status: 'CONFIRMED',
          confirmedAt: { gte: threeDaysAgo },
        },
        select: { confirmedAt: true },
      });

      // Collect distinct UTC calendar days
      const days = new Set(
        recentMatches
          .filter((m): m is typeof m & { confirmedAt: Date } => m.confirmedAt !== null)
          .map((m) => m.confirmedAt.toISOString().slice(0, 10))
      );

      // 3 distinct days in a 3-day window must be consecutive
      if (days.size < 3) continue;

      await prisma.player.update({
        where: { id: player.id },
        data: { warnings: 0 },
      });
      decayed++;

      const logChannel = client.channels.cache.get(CHANNELS.modLogs) as TextChannel | undefined;
      if (logChannel) {
        await logChannel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Green)
              .setTitle('Warnings Cleared (Activity Decay)')
              .setDescription(
                `<@${player.discordId}> played matches on 3 consecutive days — ` +
                `${player.warnings} warning(s) cleared automatically.`
              )
              .setFooter({ text: 'Cleared by system scheduler' })
              .setTimestamp(),
          ],
        });
      }
    }

    console.log(`[Scheduler] Warning decay: ${decayed} player(s) had warnings cleared.`);
  } catch (err) {
    console.error('[Scheduler] Warning decay error:', err);
  }
}

// ── Job 4: Match thread reminder (B2) ────────────────────────────────────────

/**
 * Finds PENDING matches with a thread that have been open for more than 24 hours
 * and posts a reminder ping + report-win buttons into the thread.
 */
async function runMatchReminder(client: Client): Promise<void> {
  console.log('[Scheduler] Running match reminder check...');

  try {
    const cutoff = new Date(Date.now() - MATCH_REMINDER_DELAY_MS);

    const stalePendingMatches = await prisma.match.findMany({
      where: {
        status: 'PENDING',
        threadId: { not: null },
        reportedAt: { lt: cutoff },
      },
      include: {
        player1: { select: { discordId: true } },
        player2: { select: { discordId: true } },
      },
    });

    let reminded = 0;

    for (const match of stalePendingMatches) {
      if (!match.threadId) continue;
      try {
        const thread = client.channels.cache.get(match.threadId);
        if (!thread?.isThread() || thread.archived) continue;

        const p1Id = match.player1.discordId;
        const p2Id = match.player2.discordId;

        const [p1User, p2User] = await Promise.all([
          client.users.fetch(p1Id).catch(() => null),
          client.users.fetch(p2Id).catch(() => null),
        ]);
        const p1Name = p1User?.displayName ?? 'Player 1';
        const p2Name = p2User?.displayName ?? 'Player 2';

        const winnerRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`report_win:${match.id}:${p1Id}`)
            .setLabel(`${p1Name} Won`)
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`report_win:${match.id}:${p2Id}`)
            .setLabel(`${p2Name} Won`)
            .setStyle(ButtonStyle.Success),
        );

        await thread.send({
          content: `<@${p1Id}> <@${p2Id}>`,
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Yellow)
              .setTitle('⏰ Match Reminder')
              .setDescription(
                `This match has been open for over **24 hours** with no result reported.\n\n` +
                `Please wrap up your match and click the winner below.`
              )
              .setTimestamp(),
          ],
          components: [winnerRow],
        });

        reminded++;
      } catch (threadErr) {
        console.warn(`[Scheduler] Failed to post reminder for match #${match.id}:`, threadErr);
      }
    }

    console.log(`[Scheduler] Match reminder: ${reminded}/${stalePendingMatches.length} thread(s) reminded.`);
  } catch (err) {
    console.error('[Scheduler] Match reminder error:', err);
  }
}

// ── Job 6: Ready check deadline resolution ────────────────────────────────────

/**
 * Runs every hour. Finds all PENDING matches that have passed their 3-day
 * deadline (base window or post-extension window) and resolves them by
 * ready check comparison via resolveMatchByReadyCheck().
 *
 * Deadline logic:
 *   - Not extended: deadline = reportedAt + 3 days
 *   - Extended:     deadline = extendedAt + 3 days
 */
async function runReadyCheckDeadlines(client: Client): Promise<void> {
  console.log('[Scheduler] Running ready check deadline check...');

  try {
    const now = new Date();
    const baseCutoff = new Date(Date.now() - THREE_DAYS_MS);

    // Find PENDING matches past their deadline.
    // Prisma doesn't support OR across nullable computed dates cleanly, so we
    // fetch all PENDING matches and filter in JS — expected to be a small set.
    const pendingMatches = await prisma.match.findMany({
      where: { status: 'PENDING' },
      select: { id: true, reportedAt: true, extendedAt: true },
    });

    const expired = pendingMatches.filter((m) => {
      if (m.extendedAt) {
        // Extended — deadline is 3 days after extension was granted
        return m.extendedAt.getTime() + THREE_DAYS_MS <= now.getTime();
      }
      // Not extended — deadline is 3 days after match was created
      return m.reportedAt.getTime() + THREE_DAYS_MS <= now.getTime();
    });

    if (expired.length === 0) {
      console.log('[Scheduler] Ready check deadlines: no expired matches.');
      return;
    }

    console.log(`[Scheduler] Ready check deadlines: ${expired.length} match(es) to resolve.`);

    for (const match of expired) {
      console.log(`[Scheduler] Resolving match #${match.id} by ready check...`);
      await resolveMatchByReadyCheck(client, match.id);
    }

    console.log(`[Scheduler] Ready check deadlines: processed ${expired.length} match(es).`);
  } catch (err) {
    console.error('[Scheduler] Ready check deadline error:', err);
  }
}

// ── Helper: schedule a recurring daily job at a specific UTC hour:minute ──────

/**
 * Fires `fn` at the next occurrence of `utcHour:utcMinute` UTC, then every 24h after that.
 */
function scheduleDaily(utcHour: number, utcMinute: number, fn: () => void): void {
  const msUntilNext = (): number => {
    const now = new Date();
    const next = new Date();
    next.setUTCHours(utcHour, utcMinute, 0, 0);
    if (next.getTime() <= now.getTime()) {
      next.setUTCDate(next.getUTCDate() + 1);
    }
    return next.getTime() - now.getTime();
  };

  // Use recursive setTimeout instead of setInterval so msUntilNext() is
  // recalculated on every iteration. setInterval(24h) drifts from the target
  // UTC time after each dyno restart; this approach stays accurate indefinitely.
  const schedule = (): void => {
    setTimeout(() => {
      fn();
      schedule();
    }, msUntilNext());
  };

  schedule();
}

// ── Job 7: Queue nudge ────────────────────────────────────────────────────────

/**
 * Posts a "Looking for a Match?" embed + Join Queue button in #1v1-chat.
 * Skipped if the queue already has active players (they're already engaged).
 */
async function runQueueNudge(client: Client): Promise<void> {
  console.log('[Scheduler] Running queue nudge...');

  try {
    // Skip if there are already players queued
    const queued = await getQueueList();
    if (queued.length > 0) {
      console.log(`[Scheduler] Queue nudge: skipped — ${queued.length} player(s) already in queue.`);
      return;
    }

    const chatChannel = client.channels.cache.get(CHANNELS.chat) as TextChannel | undefined;
    if (!chatChannel) {
      console.warn('[Scheduler] Queue nudge: #1v1-chat channel not found in cache.');
      return;
    }

    const nudgeEmbed = new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle('Looking for a Match?')
      .setDescription('The 1v1 queue is open. Click below to jump in and get paired.');

    const queueRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('queue_join')
        .setLabel('⚔️ Join Queue')
        .setStyle(ButtonStyle.Primary),
    );

    await chatChannel.send({ embeds: [nudgeEmbed], components: [queueRow] });
    console.log('[Scheduler] Queue nudge posted.');
  } catch (err) {
    console.error('[Scheduler] Queue nudge error:', err);
  }
}

// ── Job 5: Thread auto-archive ────────────────────────────────────────────────

async function runThreadCleanup(client: Client): Promise<void> {
  console.log('[Scheduler] Running thread cleanup...');

  try {
    const cutoff = new Date(Date.now() - THREAD_ARCHIVE_DELAY_MS);

    // Find confirmed matches with a thread that were confirmed more than 24h ago
    const staleMatches = await prisma.match.findMany({
      where: {
        status: 'CONFIRMED',
        threadId: { not: null },
        confirmedAt: { lt: cutoff },
      },
      select: { id: true, threadId: true },
    });

    let archived = 0;

    for (const match of staleMatches) {
      if (!match.threadId) continue;
      try {
        const channel = client.channels.cache.get(match.threadId);
        if (channel?.isThread() && !channel.archived) {
          await channel.setArchived(true, 'Auto-archived 24h after match confirmation');
          archived++;
        }
      } catch (threadErr) {
        console.warn(`[Scheduler] Failed to auto-archive thread for match #${match.id}:`, threadErr);
      }
    }

    console.log(`[Scheduler] Thread cleanup: ${archived} thread(s) archived out of ${staleMatches.length} stale.`);
  } catch (err) {
    console.error('[Scheduler] Thread cleanup error:', err);
  }
}

// ── Job 8: State reconciliation ───────────────────────────────────────────────

/**
 * Finds ACTIVE players whose Redis state is `in_match` but who have no entries
 * in their active match SET. This is the fingerprint of the all-banned orphan case:
 * joinQueue sets both players to `in_match` before returning allBanned: true, but
 * never calls addActiveMatch (no match record exists yet). If neither player clicks
 * Override nor Re-queue, they remain stuck indefinitely.
 *
 * Fix: reset orphaned players to `idle` and log each reset to mod-ops.
 */
async function runStateReconciliation(client: Client): Promise<void> {
  console.log('[Scheduler] Running state reconciliation...');

  try {
    const season = await prisma.season.findFirst({ where: { active: true } });
    if (!season) return;

    const activePlayers = await prisma.player.findMany({
      where: { seasonId: season.id, status: 'ACTIVE' },
      select: { discordId: true },
    });

    let fixed = 0;

    for (const player of activePlayers) {
      const state = await getPlayerState(player.discordId);
      if (state !== 'in_match') continue;

      const hasMatches = await hasActiveMatches(player.discordId);
      if (hasMatches) continue;

      // in_match with no active match SET entries — orphaned state
      await setPlayerState(player.discordId, 'idle');
      fixed++;

      const logChannel = client.channels.cache.get(CHANNELS.modLogs) as TextChannel | undefined;
      if (logChannel) {
        await logChannel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Orange)
              .setTitle('Orphaned State Cleared')
              .setDescription(
                `<@${player.discordId}> was stuck in \`in_match\` with no active match records.\n\n` +
                `State reset to \`idle\`. This typically occurs when the all-banned Override/Re-queue prompt is never resolved.`
              )
              .setFooter({ text: 'Cleared by state reconciliation job' })
              .setTimestamp(),
          ],
        });
      }
    }

    console.log(`[Scheduler] State reconciliation: ${fixed} orphaned state(s) cleared out of ${activePlayers.length} players checked.`);
  } catch (err) {
    console.error('[Scheduler] State reconciliation error:', err);
  }
}
