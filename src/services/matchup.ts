import { cacheGet, cacheSet } from './cache.js';
import { fetchMatchupsMatrix, fetchBannedMatchups, fetchDeathmatches } from './sheets.js';
import { CacheKeys, type MatchupRules, type DeathmatcAlternatives } from '../types/index.js';
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

export async function isMatchupBanned(buildA: string, buildB: string): Promise<boolean> {
  const banned = await getBannedSet();
  const key = [buildA, buildB].sort().join('::');
  return banned.has(key);
}

// ── Matchup rules ────────────────────────────────────────────────────────────

export async function getMatchupRules(buildA: string, buildB: string): Promise<MatchupRules | null> {
  const cacheKey = CacheKeys.matchup(buildA, buildB);
  const cached = await cacheGet<MatchupRules>(cacheKey);
  if (cached) return cached;

  const matrix = await fetchMatchupsMatrix();
  if (!matrix.length) return null;

  // Row 0 is the header row; col 0 is the build labels
  const headers = matrix[0].slice(1);  // column build names
  const colIndexB = headers.findIndex((h) => h.trim() === buildB);
  const rowIndexA = matrix.slice(1).findIndex((r) => r[0]?.trim() === buildA);
  const rowIndexB = matrix.slice(1).findIndex((r) => r[0]?.trim() === buildB);
  const colIndexA = headers.findIndex((h) => h.trim() === buildA);

  if (colIndexB === -1 || rowIndexA === -1 || rowIndexB === -1 || colIndexA === -1) {
    return null;
  }

  // Read both symmetric cells. Some matchups (e.g. Amazon vs Amazon) only
  // populate one side of the matrix, so fall back to the transposed cell when
  // the primary cell is empty.
  const cellAB = matrix.slice(1)[rowIndexA][colIndexB + 1]?.trim() ?? '';
  const cellBA = matrix.slice(1)[rowIndexB][colIndexA + 1]?.trim() ?? '';
  const rulesForA = cellAB || cellBA;
  const rulesForB = cellBA || cellAB;
  const isBanned = await isMatchupBanned(buildA, buildB);

  const result: MatchupRules = { buildA, buildB, rulesForA, rulesForB, isBanned };
  await cacheSet(cacheKey, result, config.cache.ttlRules);
  return result;
}

// ── Deathmatch alternatives ──────────────────────────────────────────────────

export async function getDeathmatches(build: string): Promise<DeathmatcAlternatives | null> {
  const cacheKey = CacheKeys.deathmatch(build);
  const cached = await cacheGet<DeathmatcAlternatives>(cacheKey);
  if (cached) return cached;

  const rows = await fetchDeathmatches();
  // Skip header row; each row is [build, dm1, dm2, dm3, dm4, dm5]
  const row = rows.slice(1).find((r) => r[0]?.trim() === build);
  if (!row) return null;

  const alternatives = row.slice(1).map((v) => v?.trim()).filter(Boolean);
  const result: DeathmatcAlternatives = { build, alternatives };
  await cacheSet(cacheKey, result, config.cache.ttlRules);
  return result;
}
