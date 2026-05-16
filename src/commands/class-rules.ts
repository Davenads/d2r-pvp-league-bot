import { SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction } from 'discord.js';
import type { Command } from '../types/index.js';
import { getClassRules } from '../services/content.js';
import { buildClassRulesEmbed, buildErrorEmbed, buildUnavailableEmbed } from '../utils/formatters.js';

/** Canonical class names as they appear in the Class Rules sheet tab (col A). */
const CLASS_NAMES = [
  'Amazon',
  'Assassin',
  'Barbarian',
  'Druid',
  'Necromancer',
  'Paladin',
  'Sorceress',
] as const;

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('class-rules')
    .setDescription('Show class-specific rules (omit class to show all)')
    .addStringOption((opt) =>
      opt
        .setName('class')
        .setDescription('Class to look up (omit to show all classes)')
        .setAutocomplete(true)
    ),

  async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const focused = interaction.options.getFocused().toLowerCase();
    const choices = CLASS_NAMES
      .filter((c) => c.toLowerCase().includes(focused))
      .map((c) => ({ name: c, value: c }));
    await interaction.respond(choices);
  },

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const rawClass = interaction.options.getString('class');

    try {
      const classMap = await getClassRules();

      if (rawClass) {
        // ── Single class lookup ───────────────────────────────────────────────
        const entry = classMap.get(rawClass);
        if (!entry) {
          await interaction.editReply({
            embeds: [buildErrorEmbed(`No rules found for class **${rawClass}**. Use the autocomplete list.`)],
          });
          return;
        }

        const embeds = buildClassRulesEmbed(rawClass, entry);
        const [first, ...rest] = embeds;
        await interaction.editReply({ embeds: [first] });
        for (const embed of rest) {
          await interaction.followUp({ embeds: [embed], ephemeral: true });
        }
        return;
      }

      // ── All classes ───────────────────────────────────────────────────────
      let firstSent = false;
      for (const className of CLASS_NAMES) {
        const entry = classMap.get(className);
        if (!entry) continue;

        const embeds = buildClassRulesEmbed(className, entry);

        if (!firstSent) {
          const [first, ...rest] = embeds;
          await interaction.editReply({ embeds: [first] });
          for (const embed of rest) {
            await interaction.followUp({ embeds: [embed], ephemeral: true });
          }
          firstSent = true;
        } else {
          for (const embed of embeds) {
            await interaction.followUp({ embeds: [embed], ephemeral: true });
          }
        }
      }

      if (!firstSent) {
        await interaction.editReply({ embeds: [buildUnavailableEmbed()] });
      }
    } catch (err) {
      console.error('[/class-rules]', err);
      await interaction.editReply({ embeds: [buildUnavailableEmbed()] });
    }
  },
};
