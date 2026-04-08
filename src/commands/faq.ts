import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  EmbedBuilder,
} from 'discord.js';
import type { Command } from '../types/index.js';
import { buildErrorEmbed, buildUnavailableEmbed, EMBED_COLORS } from '../utils/formatters.js';
import { getFaqEntries } from '../services/content.js';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('faq')
    .setDescription('Look up an FAQ entry')
    .addStringOption((opt) =>
      opt
        .setName('topic')
        .setDescription('Search for a specific question (leave blank to list all)')
        .setAutocomplete(true)
    ),

  async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const partial = interaction.options.getFocused().toLowerCase();

    try {
      const entries = await getFaqEntries();
      const matches = entries
        .filter((e) => e.question.toLowerCase().includes(partial))
        .slice(0, 25)
        .map((e) => ({
          name: e.question.length > 100 ? `${e.question.slice(0, 97)}...` : e.question,
          value: e.question,
        }));
      await interaction.respond(matches);
    } catch {
      await interaction.respond([]);
    }
  },

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();

    const topic = interaction.options.getString('topic');

    try {
      const entries = await getFaqEntries();

      if (!entries.length) {
        await interaction.editReply({ embeds: [buildUnavailableEmbed()] });
        return;
      }

      // No topic → list all questions
      if (!topic) {
        const listEmbed = new EmbedBuilder()
          .setColor(EMBED_COLORS.info)
          .setTitle('D2R 1v1 League — FAQ')
          .setDescription(
            entries
              .map((e, i) => `**${i + 1}.** ${e.question}`)
              .join('\n')
          )
          .setFooter({ text: 'Use /faq topic:<question> to see the full answer.' });

        await interaction.editReply({ embeds: [listEmbed] });
        return;
      }

      // Search for matching entry — exact match first, then partial
      const lower = topic.toLowerCase();
      const match =
        entries.find((e) => e.question.toLowerCase() === lower) ??
        entries.find((e) => e.question.toLowerCase().includes(lower));

      if (!match) {
        await interaction.editReply({
          embeds: [buildErrorEmbed(`No FAQ entry found for: **${topic}**\n\nUse \`/faq\` without a topic to see all questions.`)],
        });
        return;
      }

      const answerEmbed = new EmbedBuilder()
        .setColor(EMBED_COLORS.info)
        .setTitle(match.question)
        .setDescription(match.answer)
        .setFooter({ text: 'D2R 1v1 League FAQ' });

      await interaction.editReply({ embeds: [answerEmbed] });
    } catch (err) {
      console.error('[/faq]', err);
      await interaction.editReply({ embeds: [buildUnavailableEmbed()] });
    }
  },
};
