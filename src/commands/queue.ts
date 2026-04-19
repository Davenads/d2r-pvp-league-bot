import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import type { Command } from '../types/index.js';
import { executeQueueJoin } from '../utils/queueJoin.js';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Enter the match queue'),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    await executeQueueJoin(interaction);
  },
};
