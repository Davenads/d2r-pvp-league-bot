import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
  TextChannel,
} from 'discord.js';
import type { Command } from '../types/index.js';
import { buildErrorEmbed, CAIN_EMOJI } from '../utils/formatters.js';
import { prisma } from '../db/client.js';
import { getPlayerState, leaveQueue } from '../services/queue.js';
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
      // Block withdrawal while in an active match
      const state = await getPlayerState(discordId);
      if (state === 'in_match') {
        await interaction.editReply({
          embeds: [buildErrorEmbed("You're currently in an active match — report the result first with `/report-win`, then withdraw.")],
        });
        return;
      }

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

      // If queued, remove from queue first
      if (state === 'queued') {
        await leaveQueue(discordId);
      }

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
