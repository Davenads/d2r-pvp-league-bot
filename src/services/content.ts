import { cacheGet, cacheSet } from './cache.js';
import { fetchGeneralRules, fetchFaq } from './sheets.js';
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
