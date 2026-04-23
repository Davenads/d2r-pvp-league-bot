import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import type { Command } from '../../types/index.js';
import { cacheFlushPattern } from '../../services/cache.js';
import { EMBED_COLORS, CAIN_EMOJI } from '../../utils/formatters.js';
import { assertModRole } from '../../utils/modGuard.js';
import { getGeneralRules, getTestRules, getFaqEntries, getDeathmatches } from '../../services/content.js';
import { refreshBannedCache } from '../../services/matchup.js';

interface TabEntry {
  label: string;
  pattern: string;
  /** Re-warm after flush. Returns a human-readable count string, or null to skip re-warm. */
  rewarm?: () => Promise<string>;
}

const TAB_ENTRIES: Record<string, TabEntry> = {
  matchups: {
    label: 'Matchups',
    pattern: 'd2r:matchup:*',
    // 676 per-pairing keys — too expensive to re-warm all combinations upfront; lazy on next lookup
  },
  banned: {
    label: 'Banned',
    pattern: 'd2r:banned*',
    rewarm: async () => {
      const count = await refreshBannedCache();
      return `${count} banned pair${count !== 1 ? 's' : ''} loaded`;
    },
  },
  deathmatches: {
    label: 'Deathmatches',
    pattern: 'd2r:deathmatch:*',
    rewarm: async () => {
      const map = await getDeathmatches();
      return `${map.size} build${map.size !== 1 ? 's' : ''} loaded`;
    },
  },
  rules: {
    label: 'Rules',
    pattern: 'd2r:rules:*',
    rewarm: async () => {
      const lines = await getGeneralRules();
      return `${lines.length} line${lines.length !== 1 ? 's' : ''} loaded`;
    },
  },
  testRules: {
    label: 'Test Rules',
    pattern: 'd2r:rules:test*',
    rewarm: async () => {
      const lines = await getTestRules();
      return `${lines.length} line${lines.length !== 1 ? 's' : ''} loaded`;
    },
  },
  faq: {
    label: 'FAQ',
    pattern: 'd2r:faq*',
    rewarm: async () => {
      const entries = await getFaqEntries();
      return `${entries.length} entr${entries.length !== 1 ? 'ies' : 'y'} loaded`;
    },
  },
  ladder: {
    label: 'Ladder',
    pattern: 'd2r:ladder*',
    // Ladder re-warm handled by /refresh-ladder (writes leaderboard embed too)
  },
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
        interface RowResult { label: string; status: string; icon: string }
        const rows: RowResult[] = [];
        let anyCleared = false;
        let anyError = false;

        for (const key of ALL_TABS_ORDER) {
          const entry = TAB_ENTRIES[key];
          await cacheFlushPattern(entry.pattern);
          anyCleared = true;

          let status: string;
          let icon: string;

          if (entry.rewarm) {
            try {
              status = await entry.rewarm();
              icon = '✅';
            } catch {
              status = 'fetch failed — will retry on next command';
              icon = '❌';
              anyError = true;
            }
          } else if (key === 'matchups') {
            status = 'cleared — re-warms lazily on next lookup';
            icon = '🗑️';
          } else {
            // ladder
            status = 'cleared — run /refresh-ladder to re-warm';
            icon = '🗑️';
          }

          rows.push({ label: entry.label, icon, status });
        }

        const breakdown = rows.map((r) => `${r.icon} **${r.label}** — ${r.status}`).join('\n');
        const description = anyError
          ? 'Cache flushed. One or more tabs failed to re-warm from Google Sheets — check bot logs.'
          : 'Cache flushed and re-warmed. Data is live.';

        embed
          .setColor((anyError ? EMBED_COLORS.warning : EMBED_COLORS.success) as number)
          .setDescription(description)
          .addFields({ name: 'Breakdown', value: breakdown });
      } else {
        const entry = TAB_ENTRIES[tab];
        const flushed = await cacheFlushPattern(entry.pattern);

        let description: string;
        let color: number = EMBED_COLORS.success;

        if (entry.rewarm) {
          try {
            const rewarmResult = await entry.rewarm();
            description = flushed > 0
              ? `**${entry.label}** flushed (${flushed} key${flushed !== 1 ? 's' : ''}) and re-warmed — ${rewarmResult}.`
              : `**${entry.label}** cache was cold — fetched fresh from Sheets — ${rewarmResult}.`;
          } catch {
            description = `**${entry.label}** flushed but re-warm from Google Sheets failed. Check bot logs.`;
            color = EMBED_COLORS.warning;
          }
        } else if (tab === 'matchups') {
          description = flushed > 0
            ? `**Matchups** — cleared ${flushed} cached pairing${flushed !== 1 ? 's' : ''}. Rules will re-warm lazily on next lookup.`
            : `**Matchups** cache was already cold. Rules will fetch fresh on next lookup.`;
        } else {
          // ladder
          description = flushed > 0
            ? `**Ladder** cache cleared. Run \`/refresh-ladder\` to re-warm the leaderboard embed.`
            : `**Ladder** cache was already cold. Run \`/refresh-ladder\` to re-warm if needed.`;
        }

        embed.setColor(color).setDescription(description);
      }

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('[/refresh-cache]', err);
      await interaction.editReply({ content: 'Failed to refresh cache. Check Redis/Sheets connection.' });
    }
  },
};
