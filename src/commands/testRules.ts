import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import type { Command } from '../types/index.js';
import { getTestRules } from '../services/content.js';
import { parseRulesIntoSections, buildRulesEmbeds } from '../utils/rulesParser.js';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('test-rules')
    .setDescription('Display the D2R 1v1 League test ruleset'),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    try {
      const lines = await getTestRules();
      const sections = parseRulesIntoSections(lines);
      const embeds = buildRulesEmbeds(sections, 'test-rules');

      // Send each embed as its own message to stay under Discord's 6000-char
      // total-per-message limit across all combined embeds.
      const [first, ...rest] = embeds;
      await interaction.editReply({ embeds: [first] });
      for (const embed of rest) {
        await interaction.followUp({ embeds: [embed] });
      }
    } catch (err) {
      console.error('[/test-rules]', err);
      await interaction.editReply({
        content: 'Failed to load test rules. Please try again later.',
      });
    }
  },
};
