import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
  TextChannel,
  ThreadChannel,
} from 'discord.js';
import type { Command } from '../types/index.js';
import { buildErrorEmbed } from '../utils/formatters.js';
import { prisma } from '../db/client.js';
import { getActiveMatch, clearActiveMatch, setPlayerState } from '../services/queue.js';
import { updateLadderResult } from '../services/ladder.js';
import { cacheDel } from '../services/cache.js';
import { CacheKeys } from '../types/index.js';
import { CHANNELS } from '../config/channels.js';
import { updateLeaderboardEmbed } from '../services/leaderboardEmbed.js';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('report-win')
    .setDescription('Report a match result (winner initiates — recorded immediately)')
    .addUserOption((opt) =>
      opt
        .setName('opponent')
        .setDescription('The player you defeated')
        .setRequired(true)
    )
    .addBooleanOption((opt) =>
      opt
        .setName('test_rule')
        .setDescription('Was this a standard match played under the test rule? (default: false)')
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const opponent = interaction.options.getUser('opponent', true);
    const isTestRule = interaction.options.getBoolean('test_rule') ?? false;
    const reporterDiscordId = interaction.user.id;

    if (opponent.id === reporterDiscordId) {
      await interaction.editReply({ embeds: [buildErrorEmbed("You can't report a win against yourself.")] });
      return;
    }

    try {
      // Verify reporter has an active match
      const activeMatch = await getActiveMatch(reporterDiscordId);
      if (!activeMatch) {
        await interaction.editReply({
          embeds: [buildErrorEmbed("You don't have an active match. Use `/queue` to find an opponent.")],
        });
        return;
      }

      // Verify the specified opponent matches the active match
      const opponentId = activeMatch.player1DiscordId === reporterDiscordId
        ? activeMatch.player2DiscordId
        : activeMatch.player1DiscordId;

      if (opponent.id !== opponentId) {
        await interaction.editReply({
          embeds: [buildErrorEmbed(
            `Your active match is against <@${opponentId}>, not <@${opponent.id}>.\n\nIf this is wrong, contact a mod.`
          )],
        });
        return;
      }

      // Fetch full match record with both players
      const match = await prisma.match.findUnique({
        where: { id: activeMatch.matchId },
        include: { player1: true, player2: true },
      });

      if (!match) {
        await interaction.editReply({ embeds: [buildErrorEmbed('Match record not found. Contact a mod.')] });
        return;
      }

      if (match.status === 'CONFIRMED') {
        await interaction.editReply({ embeds: [buildErrorEmbed('This match result has already been confirmed.')] });
        return;
      }

      if (match.status === 'VOIDED') {
        await interaction.editReply({ embeds: [buildErrorEmbed('This match has been voided by a mod.')] });
        return;
      }

      // Determine winner / loser player records
      const winnerPlayer = match.player1.discordId === reporterDiscordId ? match.player1 : match.player2;
      const loserPlayer  = match.player1.discordId === reporterDiscordId ? match.player2 : match.player1;

      // test_rule can only override STANDARD matches — DEATHMATCH and TOURNAMENT are fixed at creation.
      const finalType = (isTestRule && match.type === 'STANDARD') ? 'TEST_RULE' : match.type;

      // ── Immediately confirm the match ─────────────────────────────────────────

      await prisma.match.update({
        where: { id: match.id },
        data: {
          winnerId:    winnerPlayer.id,
          type:        finalType,
          status:      'CONFIRMED',
          confirmedAt: new Date(),
        },
      });

      // Update lastMatchAt for both players
      await prisma.player.updateMany({
        where: { id: { in: [winnerPlayer.id, loserPlayer.id] } },
        data: { lastMatchAt: new Date() },
      });

      // Write W/L/Points to Google Sheets (non-fatal if sheet write fails)
      try {
        await updateLadderResult(winnerPlayer.discordId, loserPlayer.discordId, finalType);
      } catch (sheetErr) {
        console.error('[/report-win] Sheet write-back failed:', sheetErr);
      }

      // Invalidate ladder cache so next /ladder reflects the new result
      await cacheDel(CacheKeys.ladder());

      // Refresh the #1v1-leaderboard embed (fire-and-forget — never blocks the reply)
      updateLeaderboardEmbed(interaction.client).catch((e) =>
        console.error('[/report-win] Leaderboard embed update failed:', e)
      );

      // Clear Redis match state for both players
      await clearActiveMatch(reporterDiscordId);
      await setPlayerState(winnerPlayer.discordId, 'idle');
      await setPlayerState(loserPlayer.discordId, 'idle');

      // ── Ephemeral reply to reporter ───────────────────────────────────────────

      const typeLabel = finalType.replace('_', ' ');
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Green)
            .setTitle('Result Recorded')
            .setDescription(
              `Your win against <@${loserPlayer.discordId}> has been recorded.\n\n` +
              `**Match type:** ${typeLabel}\n` +
              `**Match #:** ${match.id}`
            )
            .setFooter({ text: 'GG! The match thread will be archived.' }),
        ],
      });

      // ── Post to #1v1-match-results ────────────────────────────────────────────

      const resultsChannel = interaction.client.channels.cache.get(CHANNELS.matchResults) as TextChannel | undefined;
      if (resultsChannel) {
        await resultsChannel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Green)
              .setTitle('Match Result')
              .addFields(
                { name: 'Winner', value: `<@${winnerPlayer.discordId}> (${match.build1Used})`, inline: true },
                { name: 'Loser',  value: `<@${loserPlayer.discordId}> (${match.build2Used})`,  inline: true },
                { name: 'Type',   value: typeLabel, inline: true },
                { name: 'Match #', value: String(match.id), inline: true },
              )
              .setTimestamp(),
          ],
        });
      }

      // ── Archive the match thread ──────────────────────────────────────────────

      if (activeMatch.threadId) {
        try {
          const thread = interaction.client.channels.cache.get(activeMatch.threadId) as ThreadChannel | undefined;
          if (thread?.isThread()) await thread.setArchived(true, 'Match result recorded');
        } catch (threadErr) {
          console.warn('[/report-win] Failed to archive thread:', threadErr);
        }
      }

    } catch (err) {
      console.error('[/report-win]', err);
      await interaction.editReply({
        embeds: [buildErrorEmbed('Failed to record result. Try again or contact a mod.')],
      });
    }
  },
};
