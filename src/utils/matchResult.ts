/**
 * Shared match result processing logic.
 * Called by both /report-win (slash command) and the report_win button handler.
 */

import {
  EmbedBuilder,
  Colors,
  TextChannel,
  ThreadChannel,
} from 'discord.js';
import type { Client } from 'discord.js';
import { prisma } from '../db/client.js';
import { removeActiveMatch, resolvePlayerStateAfterMatch } from '../services/queue.js';
import { updateLadderResult } from '../services/ladder.js';
import { cacheDel } from '../services/cache.js';
import { CacheKeys } from '../types/index.js';
import { CHANNELS } from '../config/channels.js';
import { updateLeaderboardEmbed } from '../services/leaderboardEmbed.js';
import { CAIN_EMOJI, getClassEmoji } from './formatters.js';
import type { MatchType } from '@prisma/client';

export interface MatchResultSuccess {
  success: true;
  embed: EmbedBuilder;
}
export interface MatchResultFailure {
  success: false;
  errorMessage: string;
}
export type MatchResultOutcome = MatchResultSuccess | MatchResultFailure;

/**
 * Validates and records a match result.
 *
 * @param client      Discord.js client (for channel/thread access)
 * @param matchId     Prisma Match.id
 * @param winnerId    Discord snowflake of the declared winner
 * @param reporterId  Discord snowflake of the person reporting (used to clear Redis state)
 * @param isTestRule  Whether to override match type to TEST_RULE (STANDARD matches only)
 * @param threadId    Thread to post the result embed into (falls back to match.threadId)
 */
export async function processMatchResult(
  client: Client,
  matchId: number,
  winnerId: string,
  reporterId: string,
  isTestRule: boolean,
  threadId?: string | null,
): Promise<MatchResultOutcome> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: { player1: true, player2: true },
  });

  if (!match) {
    return { success: false, errorMessage: 'Match record not found. Contact a mod.' };
  }
  if (match.status === 'CONFIRMED') {
    return { success: false, errorMessage: 'This match result has already been confirmed.' };
  }
  if (match.status === 'VOIDED') {
    return { success: false, errorMessage: 'This match has been voided by a mod.' };
  }

  const { player1, player2 } = match;
  if (winnerId !== player1.discordId && winnerId !== player2.discordId) {
    return {
      success: false,
      errorMessage: `Invalid winner — <@${winnerId}> is not a participant in match #${matchId}.`,
    };
  }

  const winnerIsP1   = player1.discordId === winnerId;
  const winnerPlayer = winnerIsP1 ? player1 : player2;
  const loserPlayer  = winnerIsP1 ? player2 : player1;

  // Defense-in-depth: catch any code path that somehow produces a self-match
  if (winnerPlayer.discordId === loserPlayer.discordId) {
    return { success: false, errorMessage: 'Invalid match — winner and loser are the same player. Contact a mod.' };
  }
  const winnerBuild  = winnerIsP1 ? match.build1Used : match.build2Used;
  const loserBuild   = winnerIsP1 ? match.build2Used : match.build1Used;

  // test_rule can only override STANDARD matches
  const finalType: MatchType = (isTestRule && match.type === 'STANDARD') ? 'TEST_RULE' : match.type;

  // ── Persist result ──────────────────────────────────────────────────────────

  await prisma.match.update({
    where: { id: match.id },
    data: {
      winnerId:    winnerPlayer.id,
      type:        finalType,
      status:      'CONFIRMED',
      confirmedAt: new Date(),
    },
  });

  await prisma.player.updateMany({
    where: { id: { in: [winnerPlayer.id, loserPlayer.id] } },
    data: { lastMatchAt: new Date() },
  });

  // ── Write-back to Google Sheets (non-fatal) ─────────────────────────────────

  try {
    await updateLadderResult(winnerPlayer.discordId, loserPlayer.discordId, finalType);
  } catch (sheetErr) {
    console.error('[processMatchResult] Sheet write-back failed:', sheetErr);
  }

  // ── Cache + leaderboard ─────────────────────────────────────────────────────

  await cacheDel(CacheKeys.ladder());
  updateLeaderboardEmbed(client).catch((e) =>
    console.error('[processMatchResult] Leaderboard embed update failed:', e)
  );

  // ── Clear Redis match state ─────────────────────────────────────────────────

  await removeActiveMatch(match.id, player1.discordId, player2.discordId);
  await resolvePlayerStateAfterMatch(player1.discordId);
  await resolvePlayerStateAfterMatch(player2.discordId);

  // ── Post to #1v1-match-results ──────────────────────────────────────────────

  const typeLabel = finalType.replace('_', ' ');

  const resultsChannel = client.channels.cache.get(CHANNELS.matchResults) as TextChannel | undefined;
  if (resultsChannel) {
    await resultsChannel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Green)
          .setTitle(`${CAIN_EMOJI} Match Result`)
          .addFields(
            { name: 'Winner', value: `<@${winnerPlayer.discordId}> (${getClassEmoji(winnerBuild)} ${winnerBuild})`, inline: true },
            { name: 'Loser',  value: `<@${loserPlayer.discordId}> (${getClassEmoji(loserBuild)} ${loserBuild})`,   inline: true },
            { name: 'Type',   value: typeLabel, inline: true },
            { name: 'Match #', value: String(match.id), inline: true },
          )
          .setTimestamp(),
      ],
    });
  }

  // ── Post result embed to match thread ───────────────────────────────────────

  const resolvedThreadId = threadId ?? match.threadId;
  if (resolvedThreadId) {
    try {
      const thread = client.channels.cache.get(resolvedThreadId) as ThreadChannel | undefined;
      if (thread?.isThread()) {
        await thread.send({
          content: `<@${winnerPlayer.discordId}> <@${loserPlayer.discordId}>`,
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Green)
              .setTitle(`${CAIN_EMOJI} Match #${match.id} — Complete`)
              .addFields(
                { name: 'Winner', value: `<@${winnerPlayer.discordId}> (${getClassEmoji(winnerBuild)} ${winnerBuild})`, inline: true },
                { name: 'Loser',  value: `<@${loserPlayer.discordId}> (${getClassEmoji(loserBuild)} ${loserBuild})`,   inline: true },
                { name: 'Type',   value: typeLabel, inline: true },
              )
              .setFooter({ text: 'GG! This thread will now be locked and archived.' })
              .setTimestamp(),
          ],
        });

        // Lock and archive in a single edit call — sending both fields in one PATCH
        // avoids the race condition where a second sequential PATCH is rejected because
        // Discord's backend hasn't fully resolved the first mutation yet.
        await thread.edit({ locked: true, archived: true }).catch((err) =>
          console.error(`[processMatchResult] Failed to lock/archive thread for match #${match.id}:`, err)
        );
      }
    } catch (threadErr) {
      console.warn('[processMatchResult] Failed to post thread result embed:', threadErr);
    }
  }

  // ── Return summary embed for the reporter's ephemeral reply ─────────────────

  return {
    success: true,
    embed: new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle(`${CAIN_EMOJI} Result Recorded`)
      .setDescription(
        `**<@${winnerPlayer.discordId}>** defeated **<@${loserPlayer.discordId}>**.\n\n` +
        `**Match type:** ${typeLabel}\n` +
        `**Match #:** ${match.id}`
      )
      .setFooter({ text: 'GG! The match thread will be archived.' }),
  };
}
