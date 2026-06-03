import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
} from 'discord.js';
import type { Command } from '../types/index.js';
import { buildErrorEmbed, CAIN_EMOJI } from '../utils/formatters.js';
import { getPlayerState, leaveQueue } from '../services/queue.js';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('leave-queue')
    .setDescription('Remove yourself from the match queue'),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const discordId = interaction.user.id;

    try {
      const state = await getPlayerState(discordId);

      if (state === 'in_match') {
        await interaction.editReply({
          embeds: [buildErrorEmbed("You're currently in an active match — you can't leave the queue. Report the result with `/report-win` or contact a mod.")],
        });
        return;
      }

      if (state !== 'queued') {
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

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Yellow)
            .setTitle(`${CAIN_EMOJI} Left Queue`)
            .setDescription("You've been removed from the queue. Use `/queue` to re-enter when ready.")
            .setTimestamp(),
        ],
      });
    } catch (err) {
      console.error('[/leave-queue]', err);
      await interaction.editReply({
        embeds: [buildErrorEmbed('Failed to leave queue. Try again or contact a mod.')],
      });
    }
  },
};
