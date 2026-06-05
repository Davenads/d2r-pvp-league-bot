/**
 * Ready check service — tracks per-player check-in counts for each match,
 * enforces the 4-hour cooldown, and auto-resolves matches past their deadline.
 *
 * Redis keys (all TTL 8 days):
 *   d2r:match:rc:{matchId}:{discordId}       → integer check-in count
 *   d2r:match:rc:last:{matchId}:{discordId}  → unix ms of last check-in
 */

import type { Client } from 'discord.js';
import { EmbedBuilder, Colors, TextChannel, ThreadChannel } from 'discord.js';
import { prisma } from '../db/client.js';
import { getRedisClient } from './cache.js';
import { cacheDel } from './cache.js';
import { CacheKeys } from '../types/index.js';
import { removeActiveMatch, resolvePlayerStateAfterMatch } from './queue.js';
import { updateLadderResultHalfPoint, updatePlayerLadderStatus } from './ladder.js';
import { updateLeaderboardEmbed } from './leaderboardEmbed.js';
import { CHANNELS } from '../config/channels.js';
import { CAIN_EMOJI } from '../utils/formatters.js';
import { config } from '../config.js';

const RC_COOLDOWN_MS  = 4 * 60 * 60 * 1000;  // 4 hours
const RC_TTL_SECONDS  = 8 * 24 * 60 * 60;     // 8 days (base 3 + extension 3 + buffer)

// ── Core read/write helpers ───────────────────────────────────────────────────

/**
 * Records a ready check click for a player in a match.
 * Enforces the 4-hour cooldown.
 *
 * Returns:
 *   success: true  → check-in recorded; includes new count
 *   success: false → on cooldown; includes next-eligible timestamp (ms)
 */
export async function recordReadyCheck(
  matchId: number,
  discordId: string,
): Promise<{ success: true; count: number } | { success: false; nextEligibleMs: number }> {
  const redis = getRedisClient();

  const lastKey = CacheKeys.matchRcLast(matchId, discordId);
  const lastRaw = await redis.get(lastKey);

  if (lastRaw) {
    const elapsed = Date.now() - parseInt(lastRaw, 10);
    if (elapsed < RC_COOLDOWN_MS) {
      const nextEligibleMs = parseInt(lastRaw, 10) + RC_COOLDOWN_MS;
      return { success: false, nextEligibleMs };
    }
  }

  const countKey = CacheKeys.matchRcCount(matchId, discordId);
  const newCount = await redis.incr(countKey);
  await redis.expire(countKey, RC_TTL_SECONDS);
  await redis.set(lastKey, String(Date.now()), 'EX', RC_TTL_SECONDS);

  return { success: true, count: newCount };
}

/** Returns the current check-in count for both players in a match. */
export async function getReadyCheckCounts(
  matchId: number,
  p1Id: string,
  p2Id: string,
): Promise<{ p1Count: number; p2Count: number }> {
  const redis = getRedisClient();
  const [p1Raw, p2Raw] = await Promise.all([
    redis.get(CacheKeys.matchRcCount(matchId, p1Id)),
    redis.get(CacheKeys.matchRcCount(matchId, p2Id)),
  ]);
  return {
    p1Count: p1Raw ? parseInt(p1Raw, 10) : 0,
    p2Count: p2Raw ? parseInt(p2Raw, 10) : 0,
  };
}

/** Deletes all ready check keys for both players in a match (used on extension and resolution). */
export async function resetReadyChecks(
  matchId: number,
  p1Id: string,
  p2Id: string,
): Promise<void> {
  const redis = getRedisClient();
  await Promise.all([
    redis.del(CacheKeys.matchRcCount(matchId, p1Id)),
    redis.del(CacheKeys.matchRcCount(matchId, p2Id)),
    redis.del(CacheKeys.matchRcLast(matchId, p1Id)),
    redis.del(CacheKeys.matchRcLast(matchId, p2Id)),
  ]);
}

// ── Deadline resolution ───────────────────────────────────────────────────────

/**
 * Called by the scheduler when a match deadline has passed (day 3 or post-extension day 3).
 *
 * Logic:
 *  - Higher RC count → winner (half-point result + warning for loser)
 *  - Equal counts, not yet extended → auto-extend 3 days, reset RC counts
 *  - Equal counts, already extended → escalate to mod-logs; no auto-resolution
 *
 * Non-throwing — logs errors internally.
 */
export async function resolveMatchByReadyCheck(client: Client, matchId: number): Promise<void> {
  try {
    const match = await prisma.match.findUnique({
      where: { id: matchId },
      include: { player1: true, player2: true },
    });

    if (!match || match.status !== 'PENDING') {
      console.log(`[readyCheck] Match #${matchId} skipped (status: ${match?.status ?? 'not found'})`);
      return;
    }

    const p1Id = match.player1.discordId;
    const p2Id = match.player2.discordId;

    const { p1Count, p2Count } = await getReadyCheckCounts(matchId, p1Id, p2Id);
    console.log(`[readyCheck] Match #${matchId} — p1 (${p1Id}): ${p1Count} checks, p2 (${p2Id}): ${p2Count} checks`);

    // ── Tie handling ──────────────────────────────────────────────────────────

    if (p1Count === p2Count) {
      const redis = getRedisClient();
      const alreadyExtended = await redis.exists(CacheKeys.matchExtended(matchId));

      if (!alreadyExtended) {
        // Auto-extend: reset RC, mark extended, update Prisma
        await resetReadyChecks(matchId, p1Id, p2Id);
        await redis.set(CacheKeys.matchExtended(matchId), 'auto', 'EX', RC_TTL_SECONDS);
        await prisma.match.update({ where: { id: matchId }, data: { extendedAt: new Date() } });

        if (match.threadId) {
          const thread = client.channels.cache.get(match.threadId) as ThreadChannel | undefined;
          if (thread?.isThread()) {
            await thread.send({
              content: `<@${p1Id}> <@${p2Id}>`,
              embeds: [
                new EmbedBuilder()
                  .setColor(Colors.Yellow)
                  .setTitle(`${CAIN_EMOJI} Match Extended — Ready Check Tie`)
                  .setDescription(
                    `Both players had equal ready check counts (**${p1Count}** each). ` +
                    'The match deadline has been automatically extended by **3 days**. Ready check counts have been reset.\n\n' +
                    '**This is the only extension allowed.** If the match is not played, the result will be determined by ready check counts from this extension window.'
                  )
                  .setTimestamp(),
              ],
            }).catch((e) => console.warn('[readyCheck] Failed to post auto-extend notice:', e));
          }
        }

        console.log(`[readyCheck] Match #${matchId} auto-extended (RC tie: ${p1Count} each)`);
        return;
      }

      // Already extended — still tied → mod escalation
      const modLogsChannel = client.channels.cache.get(CHANNELS.modLogs) as TextChannel | undefined;
      if (modLogsChannel) {
        await modLogsChannel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Orange)
              .setTitle(`${CAIN_EMOJI} Match Deadlocked — Mod Required`)
              .setDescription(
                `Match **#${matchId}** has expired including its extension. Both players have equal ready check counts (**${p1Count}** each).\n\n` +
                `**Players:** <@${p1Id}> vs <@${p2Id}>\n\n` +
                'Please resolve manually with `/admin-set-result` or `/admin-cancel-match`.'
              )
              .setTimestamp(),
          ],
        }).catch((e) => console.warn('[readyCheck] Failed to post deadlock notice:', e));
      }

      console.warn(`[readyCheck] Match #${matchId} deadlocked — equal RC counts after extension (${p1Count} each). Mod intervention required.`);
      return;
    }

    // ── Winner determined ─────────────────────────────────────────────────────

    const winnerIsP1   = p1Count > p2Count;
    const winnerPlayer = winnerIsP1 ? match.player1 : match.player2;
    const loserPlayer  = winnerIsP1 ? match.player2 : match.player1;
    const winnerCount  = winnerIsP1 ? p1Count : p2Count;
    const loserCount   = winnerIsP1 ? p2Count : p1Count;
    const winnerBuild  = winnerIsP1 ? match.build1Used : match.build2Used;
    const loserBuild   = winnerIsP1 ? match.build2Used : match.build1Used;

    // ── Persist result ────────────────────────────────────────────────────────

    await prisma.match.update({
      where: { id: matchId },
      data: {
        winnerId:    winnerPlayer.id,
        status:      'CONFIRMED',
        rcResolved:  true,
        confirmedAt: new Date(),
      },
    });

    await prisma.player.updateMany({
      where: { id: { in: [winnerPlayer.id, loserPlayer.id] } },
      data: { lastMatchAt: new Date() },
    });

    // ── Ladder write-back (half point, non-fatal) ─────────────────────────────

    try {
      await updateLadderResultHalfPoint(winnerPlayer.discordId, loserPlayer.discordId);
    } catch (sheetErr) {
      console.error('[readyCheck] Sheet write-back failed:', sheetErr);
    }

    // ── Cache + leaderboard ───────────────────────────────────────────────────

    await cacheDel(CacheKeys.ladder());
    updateLeaderboardEmbed(client).catch((e) =>
      console.error('[readyCheck] Leaderboard update failed:', e)
    );

    // ── Clear Redis match state ───────────────────────────────────────────────

    await removeActiveMatch(matchId, p1Id, p2Id);
    await resolvePlayerStateAfterMatch(p1Id);
    await resolvePlayerStateAfterMatch(p2Id);

    // ── Issue warning to loser ────────────────────────────────────────────────

    await prisma.warning.create({
      data: {
        playerId: loserPlayer.id,
        reason:   `Ready check loss — match #${matchId} (${loserCount} vs ${winnerCount} checks)`,
        issuedBy: 'system',
      },
    });

    const updatedLoser = await prisma.player.update({
      where: { id: loserPlayer.id },
      data:  { warnings: { increment: 1 } },
    });

    // Auto-remove if warning threshold hit
    if (updatedLoser.warnings >= config.league.warningThreshold) {
      await prisma.player.update({
        where: { id: loserPlayer.id },
        data:  { status: 'REMOVED', removedAt: new Date() },
      });
      try {
        await updatePlayerLadderStatus(loserPlayer.discordId, 'Removed');
      } catch (e) {
        console.error('[readyCheck] Failed to update ladder status on removal:', e);
      }
    }

    // ── Clean up RC Redis keys ────────────────────────────────────────────────

    await resetReadyChecks(matchId, p1Id, p2Id);

    // ── Post to #1v1-match-results ────────────────────────────────────────────

    const resultsChannel = client.channels.cache.get(CHANNELS.matchResults) as TextChannel | undefined;
    if (resultsChannel) {
      await resultsChannel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Orange)
            .setTitle(`${CAIN_EMOJI} Match Auto-Resolved (Ready Check)`)
            .addFields(
              { name: 'Winner', value: `<@${winnerPlayer.discordId}> (${winnerBuild}) — ${winnerCount} checks`, inline: true },
              { name: 'Loser',  value: `<@${loserPlayer.discordId}> (${loserBuild}) — ${loserCount} checks`,   inline: true },
              { name: 'Points', value: '+0.5 winner / -0.5 loser (floored at 0)', inline: false },
              { name: 'Warning', value: `${updatedLoser.warnings}/${config.league.warningThreshold} for <@${loserPlayer.discordId}>`, inline: true },
              { name: 'Match #', value: String(matchId), inline: true },
            )
            .setFooter({ text: 'Auto-resolved by ready check system' })
            .setTimestamp(),
        ],
      }).catch((e) => console.warn('[readyCheck] Failed to post to match-results:', e));
    }

    // ── Post to match thread + archive ────────────────────────────────────────

    if (match.threadId) {
      const thread = client.channels.cache.get(match.threadId) as ThreadChannel | undefined;
      if (thread?.isThread()) {
        await thread.send({
          content: `<@${p1Id}> <@${p2Id}>`,
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Orange)
              .setTitle(`${CAIN_EMOJI} Match #${matchId} — Auto-Resolved`)
              .setDescription('This match was not played within the deadline and has been resolved by ready check.')
              .addFields(
                { name: 'Winner', value: `<@${winnerPlayer.discordId}> (${winnerBuild}) — ${winnerCount} checks`, inline: true },
                { name: 'Loser',  value: `<@${loserPlayer.discordId}> (${loserBuild}) — ${loserCount} checks`,   inline: true },
                { name: 'Warning Issued', value: `<@${loserPlayer.discordId}> — ${updatedLoser.warnings}/${config.league.warningThreshold} warnings`, inline: false },
              )
              .setFooter({ text: 'This thread will now be archived.' })
              .setTimestamp(),
          ],
        }).catch((e) => console.warn('[readyCheck] Failed to post thread result:', e));

        await thread.setArchived(true, 'Match auto-resolved by ready check').catch((e) =>
          console.warn('[readyCheck] Failed to archive thread:', e)
        );
      }
    }

    console.log(
      `[readyCheck] Match #${matchId} resolved — ` +
      `winner: ${winnerPlayer.discordId} (${winnerCount} checks), ` +
      `loser: ${loserPlayer.discordId} (${loserCount} checks, warning ${updatedLoser.warnings}/${config.league.warningThreshold})`
    );

  } catch (err) {
    console.error(`[readyCheck] resolveMatchByReadyCheck error for match #${matchId}:`, err);
  }
}
