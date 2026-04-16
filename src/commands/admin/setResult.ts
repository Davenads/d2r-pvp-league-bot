import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
  TextChannel,
  ThreadChannel,
} from 'discord.js';
import type { Command } from '../../types/index.js';
import { buildErrorEmbed, EMBED_COLORS, CAIN_EMOJI } from '../../utils/formatters.js';
import { prisma } from '../../db/client.js';
import { clearActiveMatch, setPlayerState } from '../../services/queue.js';
import { updateLadderResult } from '../../services/ladder.js';
import { CHANNELS } from '../../config/channels.js';
import { assertModRole } from '../../utils/modGuard.js';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-set-result')
    .setDescription('Override or set a match result (mod only)')
    .addUserOption((opt) =>
      opt.setName('player1').setDescription('First player in the match').setRequired(true)
    )
    .addUserOption((opt) =>
      opt.setName('player2').setDescription('Second player in the match').setRequired(true)
    )
    .addUserOption((opt) =>
      opt.setName('winner').setDescription('The player who won').setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('match_type')
        .setDescription('Match type (default: Standard)')
        .addChoices(
          { name: 'Standard', value: 'STANDARD' },
          { name: 'Test Rule', value: 'TEST_RULE' },
          { name: 'Deathmatch', value: 'DEATHMATCH' },
          { name: 'Tournament', value: 'TOURNAMENT' },
        )
    )
    .addStringOption((opt) =>
      opt.setName('reason').setDescription('Reason for the override (optional)')
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    if (!await assertModRole(interaction)) return;

    const p1User = interaction.options.getUser('player1', true);
    const p2User = interaction.options.getUser('player2', true);
    const winnerUser = interaction.options.getUser('winner', true);
    const matchTypeRaw = interaction.options.getString('match_type') ?? 'STANDARD';
    const reason = interaction.options.getString('reason') ?? 'Admin override';

    // Winner must be one of the two players
    if (winnerUser.id !== p1User.id && winnerUser.id !== p2User.id) {
      await interaction.editReply({
        embeds: [buildErrorEmbed('The winner must be either player1 or player2.')],
      });
      return;
    }

    if (p1User.id === p2User.id) {
      await interaction.editReply({ embeds: [buildErrorEmbed('player1 and player2 must be different users.')] });
      return;
    }

    try {
      const season = await prisma.season.findFirst({ where: { active: true } });
      if (!season) {
        await interaction.editReply({ embeds: [buildErrorEmbed('No active season.')] });
        return;
      }

      // Find both players in Postgres
      const [p1Record, p2Record] = await Promise.all([
        prisma.player.findFirst({ where: { discordId: p1User.id, seasonId: season.id } }),
        prisma.player.findFirst({ where: { discordId: p2User.id, seasonId: season.id } }),
      ]);

      if (!p1Record) {
        await interaction.editReply({ embeds: [buildErrorEmbed(`**${p1User.username}** is not registered this season.`)] });
        return;
      }
      if (!p2Record) {
        await interaction.editReply({ embeds: [buildErrorEmbed(`**${p2User.username}** is not registered this season.`)] });
        return;
      }

      // Find the most recent unresolved match between these two players
      const match = await prisma.match.findFirst({
        where: {
          seasonId: season.id,
          status: { in: ['PENDING', 'DISPUTED'] },
          OR: [
            { player1Id: p1Record.id, player2Id: p2Record.id },
            { player1Id: p2Record.id, player2Id: p1Record.id },
          ],
        },
        orderBy: { reportedAt: 'desc' },
      });

      if (!match) {
        await interaction.editReply({
          embeds: [buildErrorEmbed(
            `No pending or disputed match found between **${p1User.username}** and **${p2User.username}**.\n\n` +
            `If this match was never created via the queue, use \`/admin-register\` to ensure both players are registered, ` +
            `then contact the developer to manually create a match record.`
          )],
        });
        return;
      }

      const winnerRecord = winnerUser.id === p1User.id ? p1Record : p2Record;
      const loserRecord = winnerUser.id === p1User.id ? p2Record : p1Record;

      // Confirm the match with admin-set winner
      await prisma.match.update({
        where: { id: match.id },
        data: {
          winnerId: winnerRecord.id,
          type: matchTypeRaw as 'STANDARD' | 'TEST_RULE' | 'DEATHMATCH' | 'TOURNAMENT',
          status: 'CONFIRMED',
          confirmedAt: new Date(),
        },
      });

      // Update lastMatchAt for both players
      await prisma.player.updateMany({
        where: { id: { in: [winnerRecord.id, loserRecord.id] } },
        data: { lastMatchAt: new Date() },
      });

      // Write W/L to Google Sheets (non-fatal)
      try {
        await updateLadderResult(winnerRecord.discordId, loserRecord.discordId, matchTypeRaw as 'STANDARD' | 'TEST_RULE' | 'DEATHMATCH');
      } catch (sheetErr) {
        console.error('[/admin-set-result] Sheet write-back failed:', sheetErr);
      }

      // Clear Redis state for both players
      await clearActiveMatch(winnerRecord.discordId);
      await setPlayerState(winnerRecord.discordId, 'idle');
      await setPlayerState(loserRecord.discordId, 'idle');

      const typeLabel = matchTypeRaw.replace('_', ' ');

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Green)
            .setTitle(`${CAIN_EMOJI} Match Result Set`)
            .addFields(
              { name: 'Winner', value: `<@${winnerRecord.discordId}>`, inline: true },
              { name: 'Loser', value: `<@${loserRecord.discordId}>`, inline: true },
              { name: 'Type', value: typeLabel, inline: true },
              { name: 'Match #', value: String(match.id), inline: true },
              { name: 'Reason', value: reason, inline: false },
            )
            .setFooter({ text: `Set by ${interaction.user.username}` })
            .setTimestamp(),
        ],
      });

      // Post result to #1v1-match-results
      const resultsChannel = interaction.client.channels.cache.get(CHANNELS.matchResults) as TextChannel | undefined;
      if (resultsChannel) {
        await resultsChannel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Green)
              .setTitle(`${CAIN_EMOJI} Match Result (Admin Override)`)
              .addFields(
                { name: 'Winner', value: `<@${winnerRecord.discordId}> (${winnerUser.id === p1User.id ? match.build1Used : match.build2Used})`, inline: true },
                { name: 'Loser', value: `<@${loserRecord.discordId}> (${winnerUser.id === p1User.id ? match.build2Used : match.build1Used})`, inline: true },
                { name: 'Type', value: typeLabel, inline: true },
              )
              .setTimestamp(),
          ],
        });
      }

      // Mod log
      const logChannel = interaction.client.channels.cache.get(CHANNELS.modLogs) as TextChannel | undefined;
      if (logChannel) {
        await logChannel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(EMBED_COLORS.warning)
              .setTitle(`${CAIN_EMOJI} Admin: Match Result Override`)
              .addFields(
                { name: 'Match #', value: String(match.id), inline: true },
                { name: 'Override By', value: `<@${interaction.user.id}>`, inline: true },
                { name: 'Winner', value: `<@${winnerRecord.discordId}>`, inline: true },
                { name: 'Loser', value: `<@${loserRecord.discordId}>`, inline: true },
                { name: 'Type', value: typeLabel, inline: true },
                { name: 'Reason', value: reason, inline: false },
              )
              .setTimestamp(),
          ],
        });
      }

      // Archive the match thread if present
      if (match.threadId) {
        try {
          const thread = interaction.client.channels.cache.get(match.threadId) as ThreadChannel | undefined;
          if (thread?.isThread()) await thread.setArchived(true, 'Match result set by admin');
        } catch (threadErr) {
          console.warn('[/admin-set-result] Failed to archive thread:', threadErr);
        }
      }
    } catch (err) {
      console.error('[/admin-set-result]', err);
      await interaction.editReply({ embeds: [buildErrorEmbed('Command failed. Check server logs.')] });
    }
  },
};
