import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import type { Command } from '../../types/index.js';
import { cacheFlushPattern } from '../../services/cache.js';
import { EMBED_COLORS } from '../../utils/formatters.js';

const TAB_PATTERNS: Record<string, string> = {
  matchups: 'd2r:matchup:*',
  banned: 'd2r:banned*',
  deathmatches: 'd2r:deathmatch:*',
  rules: 'd2r:rules:*',
  faq: 'd2r:faq*',
  ladder: 'd2r:ladder*',
  all: 'd2r:*',
};

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('refresh-cache')
    .setDescription('Force-refresh the bot cache from Google Sheets (mod only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((opt) =>
      opt
        .setName('tab')
        .setDescription('Which tab to refresh (default: all)')
        .addChoices(
          { name: 'All', value: 'all' },
          { name: 'Matchups', value: 'matchups' },
          { name: 'Banned Matchups', value: 'banned' },
          { name: 'Deathmatches', value: 'deathmatches' },
          { name: 'General Rules', value: 'rules' },
          { name: 'FAQ', value: 'faq' },
          { name: 'Ladder', value: 'ladder' },
        )
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const tab = interaction.options.getString('tab') ?? 'all';
    const pattern = TAB_PATTERNS[tab];

    if (!pattern) {
      await interaction.editReply({ content: 'Invalid tab selection.' });
      return;
    }

    try {
      const deleted = await cacheFlushPattern(pattern);

      const embed = new EmbedBuilder()
        .setColor(EMBED_COLORS.success)
        .setTitle('Cache Refreshed')
        .setDescription(`Cleared **${deleted}** cached key(s) for **${tab}**.\nThe next command using this data will fetch fresh from Google Sheets.`);

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('[/refresh-cache]', err);
      await interaction.editReply({ content: 'Failed to clear cache. Check Redis connection.' });
    }
  },
};
