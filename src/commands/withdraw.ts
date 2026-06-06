import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
  TextChannel,
  ThreadChannel,
} from 'discord.js';
import type { Command } from '../types/index.js';
import { buildErrorEmbed, CAIN_EMOJI } from '../utils/formatters.js';
import { prisma } from '../db/client.js';
import { leaveQueue, removeActiveMatch, resolvePlayerStateAfterMatch } from '../services/queue.js';
import { updatePlayerLadderStatus } from '../services/ladder.js';
import { CHANNELS } from '../config/channels.js';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('withdraw')
    .setDescription('Remove yourself from the league ladder'),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const discordId = interaction.user.id;

    try {
      const season = await prisma.season.findFirst({ where: { active: true } });
      if (!season) {
        await interaction.editReply({ embeds: [buildErrorEmbed('No active season.')] });
        return;
      }

      const player = await prisma.player.findFirst({
        where: { discordId, seasonId: season.id },
      });

      if (!player) {
        await interaction.editReply({
          embeds: [buildErrorEmbed("You aren't registered in the current season.")],
        });
        return;
      }

      if (player.status === 'REMOVED') {
        await interaction.editReply({
          embeds: [buildErrorEmbed("You've already been removed from the ladder.")],
        });
        return;
      }

      // Void all PENDING matches this player is in and clean up opponent Redis state
      const pendingMatches = await prisma.match.findMany({
        where: {
          status: 'PENDING',
          OR: [
            { player1: { discordId } },
            { player2: { discordId } },
          ],
        },
        include: { player1: true, player2: true },
      });

      for (const match of pendingMatches) {
        await prisma.match.update({
          where: { id: match.id },
          data: { status: 'VOIDED' },
        });

        const opponentDiscordId =
          match.player1.discordId === discordId
            ? match.player2.discordId
            : match.player1.discordId;

        await removeActiveMatch(match.id, discordId, opponentDiscordId);
        await resolvePlayerStateAfterMatch(opponentDiscordId);

        // Notify the match thread
        if (match.threadId) {
          try {
            const thread = interaction.client.channels.cache.get(match.threadId) as ThreadChannel | undefined;
            if (thread?.isThread()) {
              await thread.send({
                content: `<@${opponentDiscordId}>`,
                embeds: [
                  new EmbedBuilder()
                    .setColor(Colors.Orange)
                    .setTitle(`${CAIN_EMOJI} Match Voided`)
                    .setDescription(`<@${discordId}> has withdrawn from the ladder. Match #${match.id} has been voided.`)
                    .setTimestamp(),
                ],
              });
              await thread.setArchived(true, 'Player withdrew from ladder').catch(() => undefined);
            }
          } catch {
            // Non-fatal — thread may already be archived or inaccessible
          }
        }

        // Notify #1v1-match-results
        const resultsChannel = interaction.client.channels.cache.get(CHANNELS.matchResults) as TextChannel | undefined;
        if (resultsChannel) {
          await resultsChannel.send({
            embeds: [
              new EmbedBuilder()
                .setColor(Colors.Orange)
                .setTitle(`${CAIN_EMOJI} Match Voided — Player Withdrew`)
                .addFields(
                  { name: 'Match #', value: String(match.id), inline: true },
                  { name: 'Withdrew', value: `<@${discordId}>`, inline: true },
                  { name: 'Opponent', value: `<@${opponentDiscordId}>`, inline: true },
                )
                .setTimestamp(),
            ],
          });
        }
      }

      // Clean up withdrawing player's own state, then remove from queue
      await resolvePlayerStateAfterMatch(discordId);
      await leaveQueue(discordId);

      // Update Prisma record
      await prisma.player.update({
        where: { id: player.id },
        data: { status: 'REMOVED', removedAt: new Date() },
      });

      // Mirror to Google Sheets
      await updatePlayerLadderStatus(discordId, 'Removed');

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Orange)
            .setTitle(`${CAIN_EMOJI} Withdrawn from Ladder`)
            .setDescription(
              `You've been removed from the **${season.name}** ladder.\n\n` +
              (pendingMatches.length > 0
                ? `${pendingMatches.length} pending match${pendingMatches.length === 1 ? '' : 'es'} ha${pendingMatches.length === 1 ? 's' : 've'} been voided and your opponent${pendingMatches.length === 1 ? ' has' : 's have'} been notified.\n\n`
                : '') +
              `Your match history is preserved. Use \`/register\` to rejoin the league at any time.`
            )
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
              .setTitle(`${CAIN_EMOJI} Player Self-Withdrew`)
              .addFields(
                { name: 'Player', value: `<@${discordId}> (${interaction.user.username})`, inline: true },
                { name: 'Season', value: season.name, inline: true },
              )
              .setTimestamp(),
          ],
        });
      }
    } catch (err) {
      console.error('[/withdraw]', err);
      await interaction.editReply({
        embeds: [buildErrorEmbed('Failed to withdraw. Try again or contact a mod.')],
      });
    }
  },
};
