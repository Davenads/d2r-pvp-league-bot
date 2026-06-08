import { cacheGet, cacheSet } from './cache.js';
import { fetchBannedMatchups, fetchDeathmatches } from './sheets.js';
import { CacheKeys, type DeathmatchAlternatives } from '../types/index.js';
import { config } from '../config.js';

// ── Banned matchups ──────────────────────────────────────────────────────────

async function getBannedSet(): Promise<Set<string>> {
  const cached = await cacheGet<string[]>(CacheKeys.banned());
  if (cached) return new Set(cached);

  const rows = await fetchBannedMatchups();
  const pairs: string[] = [];

  // Skip header row; each row is [build, banned1, banned2, ...]
  for (const row of rows.slice(1)) {
    const [build, ...banned] = row;
    for (const opponent of banned) {
      if (opponent?.trim()) {
        // Store as sorted pair key for symmetric lookup
        const key = [build.trim(), opponent.trim()].sort().join('::');
        pairs.push(key);
      }
    }
  }

  await cacheSet(CacheKeys.banned(), pairs, config.cache.ttlRules);
  return new Set(pairs);
}

/**
 * Force-fetches the banned matchup list from Sheets, re-populates the cache,
 * and returns the number of banned pairs loaded. Used by /refresh-cache re-warm.
 */
export async function refreshBannedCache(): Promise<number> {
  const rows = await fetchBannedMatchups();
  const pairs: string[] = [];

  for (const row of rows.slice(1)) {
    const [build, ...banned] = row;
    for (const opponent of banned) {
      if (opponent?.trim()) {
        const key = [build.trim(), opponent.trim()].sort().join('::');
        pairs.push(key);
      }
    }
  }

  await cacheSet(CacheKeys.banned(), pairs, config.cache.ttlRules);
  return pairs.length;
}

export async function isMatchupBanned(buildA: string, buildB: string): Promise<boolean> {
  const banned = await getBannedSet();
  const key = [buildA, buildB].sort().join('::');
  return banned.has(key);
}

// ── Deathmatch alternatives ──────────────────────────────────────────────────

export async function getDeathmatches(build: string): Promise<DeathmatchAlternatives | null> {
  const cacheKey = CacheKeys.deathmatch(build);
  const cached = await cacheGet<DeathmatchAlternatives>(cacheKey);
  if (cached) return cached;

  const rows = await fetchDeathmatches();
  // Skip header row; each row is [build, dm1, dm2, dm3, dm4, dm5]
  const row = rows.slice(1).find((r) => r[0]?.trim() === build);
  if (!row) return null;

  const alternatives = row.slice(1).map((v) => v?.trim()).filter(Boolean);
  const result: DeathmatchAlternatives = { build, alternatives };
  await cacheSet(cacheKey, result, config.cache.ttlRules);
  return result;
}

