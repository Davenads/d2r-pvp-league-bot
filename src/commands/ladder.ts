import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import type { Command, LadderEntry } from '../types/index.js';
import { cacheGet, cacheSet } from '../services/cache.js';
import { fetchLadder } from '../services/sheets.js';
import { CacheKeys } from '../types/index.js';
import { buildLadderEmbed, buildUnavailableEmbed } from '../utils/formatters.js';
import { config } from '../config.js';

const PAGE_SIZE = 10;

async function getLadderEntries(): Promise<LadderEntry[]> {
  const cached = await cacheGet<LadderEntry[]>(CacheKeys.ladder());
  if (cached) return cached;

  const rows = await fetchLadder();
  if (rows.length < 2) return [];

  const headers = rows[0].map((h) => h.trim().toLowerCase());

  const idx = (name: string) => headers.indexOf(name);
  const entries: LadderEntry[] = rows.slice(1)
    .filter((row) => row[idx('status')]?.trim() === 'Available' && (row[idx('discord_id')] || '').trim())
    .map((row) => ({
      rank: parseInt(row[idx('rank')] || '0', 10),
      discordUsername: row[idx('discord_username')] ?? '',
      discordId: row[idx('discord_id')] ?? '',
      build1: row[idx('build_1')] ?? '',
      build2: row[idx('build_2')] || undefined,
      build3: row[idx('build_3')] || undefined,
      build4: row[idx('build_4')] || undefined,
      build5: row[idx('build_5')] || undefined,
      wins: parseInt(row[idx('w')] ?? '0', 10),
      losses: parseInt(row[idx('l')] ?? '0', 10),
      winPct: parseFloat(row[idx('w%')] ?? '0'),
      points: parseInt(row[idx('points')] ?? '0', 10),
      trWins: parseInt(row[idx('tr_w')] ?? '0', 10),
      trLosses: parseInt(row[idx('tr_l')] ?? '0', 10),
      trWinPct: parseFloat(row[idx('tr_w%')] ?? '0'),
      dmWins: parseInt(row[idx('dm_w')] ?? '0', 10),
      dmLosses: parseInt(row[idx('dm_l')] ?? '0', 10),
      status: (row[idx('status')]?.trim() ?? 'Inactive') as LadderEntry['status'],
      lastMatch: row[idx('last_match')] ?? '',
      registered: row[idx('registered')] ?? '',
      notes: row[idx('notes')] || undefined,
    }));

  await cacheSet(CacheKeys.ladder(), entries, config.cache.ttlLadder);
  return entries;
}

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('ladder')
    .setDescription('Show the current D2R 1v1 League standings')
    .addIntegerOption((opt) =>
      opt
        .setName('page')
        .setDescription('Page number (default: 1)')
        .setMinValue(1)
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const page = interaction.options.getInteger('page') ?? 1;

    try {
      const entries = await getLadderEntries();

      if (!entries.length) {
        await interaction.editReply({ embeds: [buildUnavailableEmbed()] });
        return;
      }

      const totalPages = Math.ceil(entries.length / PAGE_SIZE);
      const clampedPage = Math.min(page, totalPages);
      const slice = entries.slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE);

      await interaction.editReply({ embeds: [buildLadderEmbed(slice, clampedPage, totalPages)] });
    } catch (err) {
      console.error('[/ladder]', err);
      await interaction.editReply({ embeds: [buildUnavailableEmbed()] });
    }
  },
};
