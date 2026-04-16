import { SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction, EmbedBuilder } from 'discord.js';
import type { Command } from '../types/index.js';
import { getBuildChoices, resolveBuild } from '../utils/buildList.js';
import { cacheGet, cacheSet } from '../services/cache.js';
import { fetchBannedMatchups } from '../services/sheets.js';
import { CacheKeys } from '../types/index.js';
import { buildErrorEmbed, buildUnavailableEmbed, EMBED_COLORS, CAIN_EMOJI } from '../utils/formatters.js';
import { config } from '../config.js';
import { getClassEmoji } from '../utils/classEmojis.js';

interface BannedEntry {
  build: string;
  banned: string[];
}

async function getBannedList(): Promise<BannedEntry[]> {
  const cacheKey = `${CacheKeys.banned()}:full`;
  const cached = await cacheGet<BannedEntry[]>(cacheKey);
  if (cached) return cached;

  const rows = await fetchBannedMatchups();
  const entries: BannedEntry[] = rows
    .slice(1)  // skip header
    .filter((row) => row[0]?.trim())
    .map((row) => ({
      build: row[0].trim(),
      banned: row.slice(1).map((v) => v?.trim()).filter(Boolean),
    }));

  await cacheSet(cacheKey, entries, config.cache.ttlRules);
  return entries;
}

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('banned-matchups')
    .setDescription('List all banned matchups, optionally filtered to a specific build')
    .addStringOption((opt) =>
      opt
        .setName('build')
        .setDescription('Filter by build (optional)')
        .setAutocomplete(true)
    ),

  async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const focused = interaction.options.getFocused();
    await interaction.respond(getBuildChoices(focused));
  },

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const rawBuild = interaction.options.getString('build');

    let filterBuild: string | undefined;
    if (rawBuild) {
      filterBuild = resolveBuild(rawBuild);
      if (!filterBuild) {
        await interaction.editReply({ embeds: [buildErrorEmbed(`Unknown build: **${rawBuild}**. Use the autocomplete list.`)] });
        return;
      }
    }

    try {
      const allEntries = await getBannedList();

      const filtered = filterBuild
        ? allEntries.filter((e) => e.build === filterBuild)
        : allEntries;

      if (!filtered.length) {
        const embed = new EmbedBuilder()
          .setColor(EMBED_COLORS.info)
          .setTitle(`${CAIN_EMOJI} Banned Matchups`)
          .setDescription(filterBuild ? `No banned matchups found for **${filterBuild}**.` : '*No banned matchups found.*');
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      const lines = filtered.map((e) => {
        const emoji = getClassEmoji(e.build);
        const buildLabel = emoji ? `${emoji} **${e.build}**` : `**${e.build}**`;
        const bannedLabels = e.banned.map((b) => {
          const bEmoji = getClassEmoji(b);
          return bEmoji ? `${bEmoji} ${b}` : b;
        });
        return `${buildLabel} — banned vs: ${bannedLabels.join(', ')}`;
      });

      const filterEmoji = filterBuild ? getClassEmoji(filterBuild) : '';
      const filterLabel = filterBuild
        ? `${filterEmoji ? filterEmoji + ' ' : ''}${filterBuild}`
        : undefined;

      const embed = new EmbedBuilder()
        .setColor(EMBED_COLORS.banned)
        .setTitle(filterLabel ? `${CAIN_EMOJI} Banned Matchups — ${filterLabel}` : `${CAIN_EMOJI} All Banned Matchups`)
        .setDescription(lines.join('\n'));

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('[/banned-matchups]', err);
      await interaction.editReply({ embeds: [buildUnavailableEmbed()] });
    }
  },
};
