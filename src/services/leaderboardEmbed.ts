/**
 * Leaderboard embed service — maintains a single auto-updating embed
 * in the #1v1-leaderboard channel.
 *
 * The embed is posted once and then edited in-place on every match result
 * (and periodically refreshed by the scheduler). The Discord message ID is
 * stored in Redis so the bot can locate and edit it across restarts.
 */

import type { Client } from 'discord.js';
import { EmbedBuilder, Colors, TextChannel } from 'discord.js';
import { fetchLadder } from './sheets.js';
import { cacheGet, cacheSet } from './cache.js';
import { CacheKeys } from '../types/index.js';
import type { LadderEntry } from '../types/index.js';
import { CHANNELS } from '../config/channels.js';

const LEADERBOARD_MSG_TTL = 30 * 24 * 60 * 60; // 30 days in seconds

// ── Parsing ───────────────────────────────────────────────────────────────────

/**
 * Parses raw Ladder sheet rows into LadderEntry objects.
 * Only includes rows where Status = 'Active'.
 */
function parseLadderRows(rows: string[][]): LadderEntry[] {
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  console.log('[Leaderboard] Sheet headers:', headers);
  const idx = (name: string) => headers.indexOf(name);

  return rows
    .slice(1)
    .filter((row) => row[idx('status')]?.trim() === 'Available' && (row[idx('discord_username')] || '').trim())
    .map((row) => ({
      rank:           parseInt(row[idx('rank')] || '0', 10),
      discordUsername: row[idx('discord_username')] ?? '',
      discordId:      row[idx('discord_id')] ?? '',
      build1:         row[idx('build_1')] ?? '',
      build2:         row[idx('build_2')] || undefined,
      build3:         row[idx('build_3')] || undefined,
      build4:         row[idx('build_4')] || undefined,
      build5:         row[idx('build_5')] || undefined,
      wins:           parseInt(row[idx('w')] ?? '0', 10),
      losses:         parseInt(row[idx('l')] ?? '0', 10),
      winPct:         parseFloat(row[idx('w%')] ?? '0'),
      points:         parseInt(row[idx('points')] ?? '0', 10),
      trWins:         parseInt(row[idx('tr_w')] ?? '0', 10),
      trLosses:       parseInt(row[idx('tr_l')] ?? '0', 10),
      trWinPct:       parseFloat(row[idx('tr_w%')] ?? '0'),
      dmWins:         parseInt(row[idx('dm_w')] ?? '0', 10),
      dmLosses:       parseInt(row[idx('dm_l')] ?? '0', 10),
      status:         (row[idx('status')]?.trim() ?? 'Available') as LadderEntry['status'],
      lastMatch:      row[idx('last_match')] ?? '',
      registered:     row[idx('registered')] ?? '',
      notes:          row[idx('notes')] || undefined,
    }));
}

// ── Embed builder ─────────────────────────────────────────────────────────────

function buildLeaderboardEmbed(entries: LadderEntry[]): EmbedBuilder {
  const sorted = [...entries].sort((a, b) => {
    const aRank = a.rank > 0 && !isNaN(a.rank) ? a.rank : Infinity;
    const bRank = b.rank > 0 && !isNaN(b.rank) ? b.rank : Infinity;
    return aRank - bRank;
  });

  const lines =
    sorted.length > 0
      ? sorted.map((e) => {
          const rankLabel = e.rank > 0 && !isNaN(e.rank) ? `#${e.rank}` : '—';
          return `**${rankLabel}** ${e.discordUsername} *(${e.points} pts)*`;
        }).join('\n')
      : '*No active players on the ladder yet.*';

  return new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle('D2R 1v1 League Standings')
    .setDescription(lines)
    .setFooter({ text: 'Updated automatically after each match result.' })
    .setTimestamp();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetches fresh ladder data from Google Sheets, builds the standings embed,
 * and either edits the existing pinned message or posts a new one.
 *
 * Designed to be called fire-and-forget — logs errors internally and never
 * throws, so callers don't need to wrap it in try/catch.
 */
export async function updateLeaderboardEmbed(client: Client): Promise<void> {
  try {
    const channel = client.channels.cache.get(CHANNELS.leaderboard) as TextChannel | undefined;
    if (!channel) {
      console.warn('[Leaderboard] Channel not in cache:', CHANNELS.leaderboard);
      return;
    }

    // Always fetch fresh from Sheets — this is called after cache invalidation
    const rows = await fetchLadder();
    const entries = parseLadderRows(rows);
    const embed = buildLeaderboardEmbed(entries);

    // Try to edit the existing leaderboard message
    const storedMsgId = await cacheGet<string>(CacheKeys.leaderboardMsgId());
    if (storedMsgId) {
      try {
        const existing = await channel.messages.fetch(storedMsgId);
        await existing.edit({ embeds: [embed] });
        console.log('[Leaderboard] Embed updated (msg:', storedMsgId, ')');
        return;
      } catch {
        // Message deleted or inaccessible — fall through to post a new one
        console.warn('[Leaderboard] Stored message not found, posting new embed.');
      }
    }

    // Before posting, scan the channel for an existing bot embed to avoid duplicates.
    // This recovers from Redis key loss (cache flush, first boot, etc.).
    const botId = client.user?.id;
    if (botId) {
      try {
        const recent = await channel.messages.fetch({ limit: 20 });
        const found = recent.find(
          (m) => m.author.id === botId && m.embeds.some((e) => e.title?.includes('League Standings'))
        );
        if (found) {
          await found.edit({ embeds: [embed] });
          await cacheSet(CacheKeys.leaderboardMsgId(), found.id, LEADERBOARD_MSG_TTL);
          console.log('[Leaderboard] Recovered existing embed via channel scan (msg:', found.id, ')');
          return;
        }
      } catch (scanErr) {
        console.warn('[Leaderboard] Channel scan failed, posting new embed:', scanErr);
      }
    }

    // Post a new leaderboard message and store its ID
    const msg = await channel.send({ embeds: [embed] });
    await cacheSet(CacheKeys.leaderboardMsgId(), msg.id, LEADERBOARD_MSG_TTL);
    console.log('[Leaderboard] New embed posted (msg:', msg.id, ')');

  } catch (err) {
    console.error('[Leaderboard] Failed to update embed:', err);
  }
}
