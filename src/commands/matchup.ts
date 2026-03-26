import { SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction } from 'discord.js';
import type { Command } from '../types/index.js';
import { getBuildChoices, resolveBuild } from '../utils/buildList.js';
import { getMatchupRules } from '../services/matchup.js';
import { buildMatchupEmbed, buildBannedMatchupEmbed, buildErrorEmbed, buildUnavailableEmbed } from '../utils/formatters.js';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('matchup')
    .setDescription('Look up the rules for a specific build vs build matchup')
    .addStringOption((opt) =>
      opt
        .setName('your_build')
        .setDescription('Your build')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('opponent_build')
        .setDescription("Your opponent's build")
        .setRequired(true)
        .setAutocomplete(true)
    ),

  async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const focused = interaction.options.getFocused();
    await interaction.respond(getBuildChoices(focused));
  },

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();

    const rawA = interaction.options.getString('your_build', true);
    const rawB = interaction.options.getString('opponent_build', true);

    const buildA = resolveBuild(rawA);
    const buildB = resolveBuild(rawB);

    if (!buildA) {
      await interaction.editReply({ embeds: [buildErrorEmbed(`Unknown build: **${rawA}**. Use the autocomplete list.`)] });
      return;
    }
    if (!buildB) {
      await interaction.editReply({ embeds: [buildErrorEmbed(`Unknown build: **${rawB}**. Use the autocomplete list.`)] });
      return;
    }
    if (buildA === buildB) {
      await interaction.editReply({ embeds: [buildErrorEmbed('Mirror matches require mutual consent from both players. This command is for matchup rules only.')] });
      return;
    }

    try {
      const rules = await getMatchupRules(buildA, buildB);

      if (!rules) {
        await interaction.editReply({ embeds: [buildUnavailableEmbed()] });
        return;
      }

      if (rules.isBanned) {
        await interaction.editReply({ embeds: [buildBannedMatchupEmbed(buildA, buildB)] });
        return;
      }

      await interaction.editReply({ embeds: [buildMatchupEmbed(rules)] });
    } catch (err) {
      console.error('[/matchup]', err);
      await interaction.editReply({ embeds: [buildUnavailableEmbed()] });
    }
  },
};
