import { cacheGet, cacheSet } from './cache.js';
import { fetchGeneralRules, fetchTestRules, fetchFaq, fetchDeathmatches } from './sheets.js';
import { CacheKeys } from '../types/index.js';
import { config } from '../config.js';

// ── General Rules ─────────────────────────────────────────────────────────────

/**
 * Returns all general rules as an array of non-empty strings.
 * Each element is one rule line from the sheet.
 */
export async function getGeneralRules(): Promise<string[]> {
  const cached = await cacheGet<string[]>(CacheKeys.rulesGeneral());
  if (cached) return cached;

  const rows = await fetchGeneralRules();
  // Flatten 2D array into lines, skip empty rows
  const lines = rows
    .flatMap((row) => row.map((cell) => cell?.trim()))
    .filter(Boolean) as string[];

  await cacheSet(CacheKeys.rulesGeneral(), lines, config.cache.ttlRules);
  return lines;
}

/**
 * Returns all test rules as an array of non-empty strings.
 * Each element is one line from the 'Test 1v1 Rules' sheet tab.
 */
export async function getTestRules(): Promise<string[]> {
  const cached = await cacheGet<string[]>(CacheKeys.rulesTest());
  if (cached) return cached;

  const rows = await fetchTestRules();
  const lines = rows
    .flatMap((row) => row.map((cell) => cell?.trim()))
    .filter(Boolean) as string[];

  await cacheSet(CacheKeys.rulesTest(), lines, config.cache.ttlRules);
  return lines;
}

// ── FAQ ───────────────────────────────────────────────────────────────────────

export interface FaqEntry {
  question: string;
  answer: string;
}

/**
 * Returns FAQ entries parsed from the Questions sheet tab.
 * Expects rows in format: [question, answer]
 * Skips the header row and any rows missing a question or answer.
 */
export async function getFaqEntries(): Promise<FaqEntry[]> {
  const cached = await cacheGet<FaqEntry[]>(CacheKeys.faq());
  if (cached) return cached;

  const rows = await fetchFaq();
  const entries: FaqEntry[] = rows
    .slice(1)  // skip header row
    .filter((row) => row[0]?.trim() && row[1]?.trim())
    .map((row) => ({
      question: row[0].trim(),
      answer: row[1].trim(),
    }));

  await cacheSet(CacheKeys.faq(), entries, config.cache.ttlRules);
  return entries;
}

// ── Deathmatches ──────────────────────────────────────────────────────────────

/**
 * Returns a Map of canonical build name → array of deathmatch opponent names.
 * Source: 'Matchups: Deathmatches' sheet tab.
 * Row format: [build, dm1, dm2, dm3, dm4, dm5] (columns B–F may be blank)
 * Cached in Redis as a plain object and reconstructed into a Map on read.
 */
export async function getDeathmatches(): Promise<Map<string, string[]>> {
  const cached = await cacheGet<Record<string, string[]>>(CacheKeys.deathmatches());
  if (cached) {
    return new Map(Object.entries(cached));
  }

  const rows = await fetchDeathmatches();
  const map: Record<string, string[]> = {};

  for (const row of rows) {
    const build = row[0]?.trim();
    if (!build) continue;
    const opponents = row.slice(1).map((c) => c?.trim()).filter(Boolean) as string[];
    map[build] = opponents;
  }

  await cacheSet(CacheKeys.deathmatches(), map, config.cache.ttlRules);
  return new Map(Object.entries(map));
}
