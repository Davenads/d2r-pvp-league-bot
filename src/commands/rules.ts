import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import type { Command } from '../types/index.js';
import { buildErrorEmbed, buildUnavailableEmbed, EMBED_COLORS } from '../utils/formatters.js';
import { getGeneralRules } from '../services/content.js';
import { ALL_CLASS_EMOJIS } from '../utils/classEmojis.js';

// Discord embed description cap
const EMBED_MAX = 4000;

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('rules')
    .setDescription('Display the D2R 1v1 League general rules'),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();

    try {
      const lines = await getGeneralRules();

      if (!lines.length) {
        await interaction.editReply({ embeds: [buildUnavailableEmbed()] });
        return;
      }

      // Join lines and chunk if over embed limit
      const fullText = lines.join('\n');
      const chunks = splitIntoChunks(fullText, EMBED_MAX);

      const embeds = chunks.map((chunk, i) =>
        new EmbedBuilder()
          .setColor(EMBED_COLORS.rules)
          .setTitle(i === 0 ? 'D2R 1v1 League — General Rules' : 'Rules (continued)')
          .setDescription(i === 0 ? `${ALL_CLASS_EMOJIS}\n\n${chunk}` : chunk)
          .setFooter(
            i === chunks.length - 1
              ? { text: 'Use /matchup <build> <build> for matchup-specific rules.' }
              : null
          )
      );

      // Discord allows up to 10 embeds per message
      await interaction.editReply({ embeds: embeds.slice(0, 10) });
    } catch (err) {
      console.error('[/rules]', err);
      await interaction.editReply({ embeds: [buildUnavailableEmbed()] });
    }
  },
};

/** Splits a long string into chunks that fit within the character limit. */
function splitIntoChunks(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  const lines = text.split('\n');
  let current = '';

  for (const line of lines) {
    if ((current + '\n' + line).length > maxLen) {
      if (current) chunks.push(current.trim());
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
