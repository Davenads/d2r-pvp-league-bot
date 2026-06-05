import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Colors,
} from 'discord.js';
import type { Command } from '../types/index.js';
import { buildErrorEmbed, CAIN_EMOJI } from '../utils/formatters.js';
import { getQueuePosition, leaveQueue } from '../services/queue.js';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('leave-queue')
    .setDescription('Remove yourself from the match queue'),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const discordId = interaction.user.id;

    try {
      const queuePosition = await getQueuePosition(discordId);

      if (queuePosition === 0) {
        await interaction.editReply({
          embeds: [buildErrorEmbed("You aren't in the queue.")],
        });
        return;
      }

      const removed = await leaveQueue(discordId);

      if (!removed) {
        await interaction.editReply({
          embeds: [buildErrorEmbed("You weren't found in the queue. Your state has been reset to idle.")],
        });
        return;
      }

      const rejoinRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('queue_join')
          .setLabel('Join Queue')
          .setStyle(ButtonStyle.Primary),
      );

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Yellow)
            .setTitle(`${CAIN_EMOJI} Left Queue`)
            .setDescription("You've been removed from the queue. Click below or use `/queue` to re-enter when ready.")
            .setTimestamp(),
        ],
        components: [rejoinRow],
      });
    } catch (err) {
      console.error('[/leave-queue]', err);
      await interaction.editReply({
        embeds: [buildErrorEmbed('Failed to leave queue. Try again or contact a mod.')],
      });
    }
  },
};
