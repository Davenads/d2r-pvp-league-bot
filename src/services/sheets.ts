import { google, sheets_v4 } from 'googleapis';
import { config } from '../config.js';

// ── Sheet tab names ──────────────────────────────────────────────────────────

export const SHEET_TABS = {
  matchups: 'Matchups',
  banned: 'Banned matchups',
  deathmatches: 'Matchups: Deathmatches',
  rules: 'TDL Rules',
  questions: 'Questions',
  ladder: 'Ladder',
} as const;

// ── Auth ─────────────────────────────────────────────────────────────────────

let sheetsClient: sheets_v4.Sheets | null = null;

function getSheetsClient(): sheets_v4.Sheets {
  if (!sheetsClient) {
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: config.google.serviceAccountEmail,
        private_key: config.google.privateKey,
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    sheetsClient = google.sheets({ version: 'v4', auth });
  }
  return sheetsClient;
}

// ── Generic range reader ─────────────────────────────────────────────────────

/**
 * Reads a range from the sheet and returns raw 2D array.
 * Throws on API failure — callers handle the error and fall back to cache.
 */
export async function readRange(range: string): Promise<string[][]> {
  const sheets = getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: config.google.sheetId,
    range,
  });
  return (response.data.values ?? []) as string[][];
}

// ── Tab-specific readers ─────────────────────────────────────────────────────

/**
 * Returns the full Matchups matrix as a 2D array (including header row/col).
 */
export async function fetchMatchupsMatrix(): Promise<string[][]> {
  return readRange(SHEET_TABS.matchups);
}

/**
 * Returns the Banned matchups tab as a 2D array.
 * Row format: [build, banned1, banned2, ..., banned5]
 */
export async function fetchBannedMatchups(): Promise<string[][]> {
  return readRange(SHEET_TABS.banned);
}

/**
 * Returns the Deathmatches tab as a 2D array.
 * Row format: [build, dm1, dm2, dm3, dm4, dm5]
 */
export async function fetchDeathmatches(): Promise<string[][]> {
  return readRange(SHEET_TABS.deathmatches);
}

/**
 * Returns the D2R 1v1 League Rules tab content.
 */
export async function fetchGeneralRules(): Promise<string[][]> {
  return readRange(SHEET_TABS.rules);
}

/**
 * Returns the Questions (FAQ) tab content.
 */
export async function fetchFaq(): Promise<string[][]> {
  return readRange(SHEET_TABS.questions);
}

/**
 * Returns the full Ladder tab as a 2D array (including header row).
 */
export async function fetchLadder(): Promise<string[][]> {
  return readRange(`${SHEET_TABS.ladder}!A:R`);
}
