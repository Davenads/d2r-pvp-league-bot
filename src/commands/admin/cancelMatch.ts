import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
  TextChannel,
  ThreadChannel,
} from 'discord.js';
import type { Command } from '../../types/index.js';
import { buildErrorEmbed, CAIN_EMOJI } from '../../utils/formatters.js';
import { prisma } from '../../db/client.js';
import { CHANNELS } from '../../config/channels.js';
import { assertModRole } from '../../utils/modGuard.js';
import { removeActiveMatch, resolvePlayerStateAfterMatch } from '../../services/queue.js';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-cancel-match')
    .setDescription('Void a pending match and return both players to idle (mod only)')
    .addIntegerOption((opt) =>
      opt
        .setName('match_id')
        .setDescription('The match ID to cancel')
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('reason')
        .setDescription('Reason for cancellation (optional)')
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    if (!await assertModRole(interaction)) return;

    const matchId = interaction.options.getInteger('match_id', true);
    const reason = interaction.options.getString('reason') ?? 'No reason provided';

    try {
      const match = await prisma.match.findUnique({
        where: { id: matchId },
        include: { player1: true, player2: true },
      });

      if (!match) {
        await interaction.editReply({ embeds: [buildErrorEmbed(`Match #${matchId} not found.`)] });
        return;
      }

      if (match.status === 'CONFIRMED') {
        await interaction.editReply({
          embeds: [buildErrorEmbed(`Match #${matchId} has already been confirmed and cannot be cancelled. Use \`/admin-set-result\` to override a confirmed result.`)],
        });
        return;
      }

      if (match.status === 'VOIDED') {
        await interaction.editReply({
          embeds: [buildErrorEmbed(`Match #${matchId} is already voided.`)],
        });
        return;
      }

      const { player1, player2 } = match;

      // Void the Prisma record
      await prisma.match.update({
        where: { id: matchId },
        data: { status: 'VOIDED' },
      });

      // Remove this match from both players' active match SETs
      await removeActiveMatch(matchId, player1.discordId, player2.discordId);

      // Conditionally return players to idle (respects queued state and remaining matches)
      await Promise.all([
        resolvePlayerStateAfterMatch(player1.discordId),
        resolvePlayerStateAfterMatch(player2.discordId),
      ]);

      // Archive the match thread if it exists
      if (match.threadId) {
        try {
          const thread = interaction.client.channels.cache.get(match.threadId) as ThreadChannel | undefined;
          if (thread?.isThread()) {
            await thread.send({
              embeds: [
                new EmbedBuilder()
                  .setColor(Colors.Red)
                  .setTitle(`${CAIN_EMOJI} Match #${matchId} — Cancelled`)
                  .setDescription(`This match has been cancelled by a moderator.\n\n**Reason:** ${reason}`)
                  .setTimestamp(),
              ],
            });
            await thread.setArchived(true, 'Match cancelled by mod').catch((err) =>
              console.warn(`[/admin-cancel-match] Failed to archive thread for match #${matchId}:`, err)
            );
          }
        } catch (threadErr) {
          console.warn('[/admin-cancel-match] Failed to post to match thread:', threadErr);
        }
      }

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Orange)
            .setTitle(`${CAIN_EMOJI} Match Cancelled`)
            .setDescription(`Match **#${matchId}** has been voided.`)
            .addFields(
              { name: 'Player 1', value: `<@${player1.discordId}>`, inline: true },
              { name: 'Player 2', value: `<@${player2.discordId}>`, inline: true },
              { name: 'Reason', value: reason, inline: false },
            )
            .setFooter({ text: `Cancelled by ${interaction.user.username}` })
            .setTimestamp(),
        ],
      });

      // Mod log
      const logChannel = interaction.client.channels.cache.get(CHANNELS.modLogs) as TextChannel | undefined;
      if (logChannel) {
        await logChannel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Orange)
              .setTitle(`${CAIN_EMOJI} Admin: Match Cancelled`)
              .addFields(
                { name: 'Match #', value: String(matchId), inline: true },
                { name: 'Cancelled By', value: `<@${interaction.user.id}>`, inline: true },
                { name: 'Player 1', value: `<@${player1.discordId}>`, inline: true },
                { name: 'Player 2', value: `<@${player2.discordId}>`, inline: true },
                { name: 'Reason', value: reason, inline: false },
              )
              .setTimestamp(),
          ],
        });
      }
    } catch (err) {
      console.error('[/admin-cancel-match]', err);
      await interaction.editReply({ embeds: [buildErrorEmbed('Command failed. Check server logs.')] });
    }
  },
};
