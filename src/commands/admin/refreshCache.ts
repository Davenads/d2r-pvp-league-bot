import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import type { Command } from '../../types/index.js';
import { cacheFlushPattern } from '../../services/cache.js';
import { EMBED_COLORS, CAIN_EMOJI } from '../../utils/formatters.js';
import { assertModRole } from '../../utils/modGuard.js';

interface TabEntry {
  label: string;
  pattern: string;
}

const TAB_ENTRIES: Record<string, TabEntry> = {
  matchups:    { label: 'Matchups',      pattern: 'd2r:matchup:*' },
  banned:      { label: 'Banned',        pattern: 'd2r:banned*' },
  deathmatches:{ label: 'Deathmatches',  pattern: 'd2r:deathmatch:*' },
  rules:       { label: 'Rules',         pattern: 'd2r:rules:*' },
  testRules:   { label: 'Test Rules',    pattern: 'd2r:rules:test*' },
  faq:         { label: 'FAQ',           pattern: 'd2r:faq*' },
  ladder:      { label: 'Ladder',        pattern: 'd2r:ladder*' },
};

const ALL_TABS_ORDER: (keyof typeof TAB_ENTRIES)[] = [
  'matchups', 'banned', 'deathmatches', 'rules', 'testRules', 'faq', 'ladder',
];

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('refresh-cache')
    .setDescription('Force-refresh the bot cache from Google Sheets (mod only)')
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
          { name: 'Test Rules', value: 'testRules' },
          { name: 'FAQ', value: 'faq' },
          { name: 'Ladder', value: 'ladder' },
        )
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    if (!await assertModRole(interaction)) return;

    const tab = interaction.options.getString('tab') ?? 'all';

    if (tab !== 'all' && !(tab in TAB_ENTRIES)) {
      await interaction.editReply({ content: 'Invalid tab selection.' });
      return;
    }

    try {
      const embed = new EmbedBuilder()
        .setTitle(`${CAIN_EMOJI} Cache Refreshed`)
        .setTimestamp()
        .setFooter({ text: `Triggered by ${interaction.user.tag}` });

      if (tab === 'all') {
        // Flush each tab individually to get per-category counts
        const results: { label: string; count: number }[] = [];
        let total = 0;

        for (const key of ALL_TABS_ORDER) {
          const { label, pattern } = TAB_ENTRIES[key];
          const count = await cacheFlushPattern(pattern);
          results.push({ label, count });
          total += count;
        }

        const breakdown = results
          .map((r) => `${r.count > 0 ? '🗑️' : '⬜'} **${r.label}** — ${r.count === 0 ? 'already cold' : `${r.count} key${r.count !== 1 ? 's' : ''}`}`)
          .join('\n');

        const description = total === 0
          ? 'All caches were already cold — nothing to clear.\nNext commands will fetch fresh from Google Sheets regardless.'
          : `Cleared **${total}** total key(s) across all tabs.\nNext commands will fetch fresh from Google Sheets.`;

        embed
          .setColor(total > 0 ? EMBED_COLORS.success : EMBED_COLORS.info)
          .setDescription(description)
          .addFields({ name: 'Breakdown', value: breakdown });
      } else {
        const { label, pattern } = TAB_ENTRIES[tab];
        const deleted = await cacheFlushPattern(pattern);

        const description = deleted === 0
          ? `**${label}** cache was already cold — nothing to clear.\nNext command will fetch fresh from Google Sheets regardless.`
          : `Cleared **${deleted}** key${deleted !== 1 ? 's' : ''} from **${label}** cache.\nNext command using this data will fetch fresh from Google Sheets.`;

        embed
          .setColor(deleted > 0 ? EMBED_COLORS.success : EMBED_COLORS.info)
          .setDescription(description);
      }

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('[/refresh-cache]', err);
      await interaction.editReply({ content: 'Failed to clear cache. Check Redis connection.' });
    }
  },
};
