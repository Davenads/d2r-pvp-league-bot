import { fetchBlacklist } from './sheets.js';
import { cacheGet, cacheSet, cacheDel } from './cache.js';
import { resolveBuild } from '../utils/buildList.js';
import { config } from '../config.js';

const CACHE_KEY = 'd2r:blacklist';

/**
 * Parses raw sheet rows into arrays of canonical build names.
 * Each row is a pipe-separated string of build names (e.g. "Assassin - Hybrid|Assassin - Ghost").
 * Rows that fail to resolve any token are skipped with a warning.
 * Duplicate combos (same set of builds) are deduplicated.
 */
function parseBlacklistRows(rows: string[][]): string[][] {
  const seen = new Set<string>();
  const result: string[][] = [];

  for (const row of rows) {
    const raw = row[0]?.trim();
    if (!raw) continue;

    const tokens = raw.split('|').map((t) => t.trim()).filter(Boolean);
    if (tokens.length < 2) {
      console.warn('[Blacklist] Skipping row with fewer than 2 tokens:', raw);
      continue;
    }

    const resolved: string[] = [];
    let failed = false;

    for (const token of tokens) {
      const canonical = resolveBuild(token);
      if (!canonical) {
        console.warn(`[Blacklist] Could not resolve build token: "${token}" in row: "${raw}"`);
        failed = true;
        break;
      }
      resolved.push(canonical);
    }

    if (failed) continue;

    // Deduplicate by normalizing the set to a sorted key
    const key = [...resolved].sort().join('::');
    if (seen.has(key)) continue;
    seen.add(key);

    result.push(resolved);
  }

  return result;
}

/**
 * Fetches and caches the blacklist from the sheet.
 * Returns the parsed list of blacklisted build combos (each is an array of canonical names).
 */
export async function loadBlacklist(): Promise<string[][]> {
  const rows = await fetchBlacklist();
  const parsed = parseBlacklistRows(rows);
  await cacheSet(CACHE_KEY, parsed, config.cache.ttlRules);
  console.log(`[Blacklist] Loaded and cached ${parsed.length} combos.`);
  return parsed;
}

/**
 * Returns the cached blacklist, fetching live from the sheet on cache miss.
 */
export async function getBlacklist(): Promise<string[][]> {
  const cached = await cacheGet<string[][]>(CACHE_KEY);
  if (cached) return cached;
  return loadBlacklist();
}

/**
 * Invalidates the blacklist cache key.
 */
export async function invalidateBlacklist(): Promise<void> {
  await cacheDel(CACHE_KEY);
}

/**
 * Checks whether a player's registered builds violate any blacklist entry.
 *
 * A violation occurs when the player's build set is a SUBSET of a blacklisted combo
 * (i.e. all of the player's builds are contained within the blacklisted group,
 * meaning they have zero builds outside it).
 *
 * Returns the violating combo as a display string if blocked, or null if allowed.
 */
export async function checkBlacklistViolation(playerBuilds: string[]): Promise<string | null> {
  const blacklist = await getBlacklist();
  const playerSet = new Set(playerBuilds);

  for (const combo of blacklist) {
    const comboSet = new Set(combo);
    // Check if every player build is contained within this combo
    const isSubset = playerBuilds.every((b) => comboSet.has(b));
    if (isSubset) {
      return combo.join(', ');
    }
  }

  return null;
}
