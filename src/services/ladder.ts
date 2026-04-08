/**
 * Ladder service — handles W/L write-back to the Google Sheets Ladder tab
 * on match confirmation.
 *
 * Column layout (0-indexed from A):
 *   A=0 Rank | B=1 Discord_Username | C=2 Discord_UUID | D=3 Build1 | E=4 Build2
 *   F=5 Wins | G=6 Losses | H=7 Win% | I=8 Points
 *   J=9 TR_W | K=10 TR_L | L=11 TR_W%
 *   M=12 DM_W | N=13 DM_L | O=14 Status | P=15 Last_Match | Q=16 Registered | R=17 Notes
 */

import { google, sheets_v4 } from 'googleapis';
import { config, resolveGoogleCredentials } from '../config.js';
import { MatchType } from '@prisma/client';

// ── Write-enabled Sheets client ───────────────────────────────────────────────

let writeClient: sheets_v4.Sheets | null = null;

function getWriteClient(): sheets_v4.Sheets {
  if (!writeClient) {
    const { serviceAccountEmail, privateKey } = resolveGoogleCredentials();
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: serviceAccountEmail,
        private_key: privateKey,
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    writeClient = google.sheets({ version: 'v4', auth });
  }
  return writeClient;
}

const LADDER_TAB = 'Ladder';
const COL = {
  discordUuid: 2,   // C (0-indexed)
  wins:        5,   // F
  losses:      6,   // G
  trWins:      9,   // J
  trLosses:   10,   // K
  dmWins:     12,   // M
  dmLosses:   13,   // N
  lastMatch:  15,   // P
} as const;

/** Converts a 0-indexed column number to A1 column letter(s). */
function colLetter(n: number): string {
  let result = '';
  let num = n + 1;
  while (num > 0) {
    const rem = (num - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    num = Math.floor((num - 1) / 26);
  }
  return result;
}

/**
 * Fetches the full Ladder tab and returns it as a 2D array.
 * Row 0 is the header row. Player rows start at index 1 (sheet row 2).
 */
async function fetchLadderRaw(): Promise<string[][]> {
  const sheets = getWriteClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: config.google.sheetId,
    range: `${LADDER_TAB}!A:R`,
  });
  return (response.data.values ?? []) as string[][];
}

/**
 * Finds a player's sheet row index (1-based, including header).
 * Returns null if not found.
 */
function findPlayerRow(rows: string[][], discordId: string): number | null {
  // rows[0] is header, rows[1] is sheet row 2, etc.
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][COL.discordUuid]?.trim() === discordId) {
      return i + 1;  // 1-based sheet row number
    }
  }
  return null;
}

/**
 * Increments a numeric cell value in the sheet by 1.
 * Returns the update data for batchUpdate.
 */
function makeIncrement(
  rows: string[][],
  sheetRow: number,
  col: number,
  amount = 1,
): sheets_v4.Schema$ValueRange {
  const currentVal = parseInt(rows[sheetRow - 1][col] ?? '0', 10) || 0;
  return {
    range: `${LADDER_TAB}!${colLetter(col)}${sheetRow}`,
    values: [[currentVal + amount]],
  };
}

/**
 * Appends a new player row to the Ladder sheet on registration.
 * Numeric stat columns are seeded to 0. Formula columns (Win%, Points, etc.)
 * are left blank so the sheet can compute them.
 *
 * Column order (A–R):
 *   A Rank | B Discord_Username | C Discord_UUID | D Build1 | E Build2
 *   F Wins | G Losses | H Win% | I Points
 *   J TR_W | K TR_L | L TR_W%
 *   M DM_W | N DM_L | O Status | P Last_Match | Q Registered | R Notes
 */
export async function addPlayerToLadder(
  discordId: string,
  discordUsername: string,
  build1: string,
  build2: string,
): Promise<void> {
  const sheets = getWriteClient();
  const today = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });

  // A full row seeded with zeros for stat columns; formula columns left blank
  const row = [
    '',              // A — Rank (sheet formula)
    discordUsername, // B — Discord_Username
    discordId,       // C — Discord_UUID
    build1,          // D — Build1
    build2,          // E — Build2
    0,               // F — Wins
    0,               // G — Losses
    '',              // H — Win% (sheet formula)
    '',              // I — Points (sheet formula)
    0,               // J — TR_W
    0,               // K — TR_L
    '',              // L — TR_W% (sheet formula)
    0,               // M — DM_W
    0,               // N — DM_L
    'Available',     // O — Status
    '',              // P — Last_Match
    today,           // Q — Registered
    '',              // R — Notes
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: config.google.sheetId,
    range: `${LADDER_TAB}!A:R`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  });
}

/**
 * Writes confirmed match W/L increments to the Ladder sheet.
 *
 * @param winnerDiscordId - Discord snowflake of the winner
 * @param loserDiscordId  - Discord snowflake of the loser
 * @param matchType       - STANDARD | TEST_RULE | DEATHMATCH
 */
export async function updateLadderResult(
  winnerDiscordId: string,
  loserDiscordId: string,
  matchType: MatchType,
): Promise<void> {
  const sheets = getWriteClient();
  const rows = await fetchLadderRaw();

  const winnerRow = findPlayerRow(rows, winnerDiscordId);
  const loserRow = findPlayerRow(rows, loserDiscordId);

  if (!winnerRow || !loserRow) {
    console.warn(
      `[Ladder] Player row not found — winner: ${winnerRow ? '✓' : '✗'} (${winnerDiscordId}), ` +
      `loser: ${loserRow ? '✓' : '✗'} (${loserDiscordId})`
    );
    return;
  }

  const today = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
  const updates: sheets_v4.Schema$ValueRange[] = [];

  if (matchType === 'STANDARD') {
    updates.push(makeIncrement(rows, winnerRow, COL.wins));
    updates.push(makeIncrement(rows, loserRow, COL.losses));
  } else if (matchType === 'TEST_RULE') {
    updates.push(makeIncrement(rows, winnerRow, COL.trWins));
    updates.push(makeIncrement(rows, loserRow, COL.trLosses));
  } else if (matchType === 'DEATHMATCH') {
    updates.push(makeIncrement(rows, winnerRow, COL.dmWins));
    updates.push(makeIncrement(rows, loserRow, COL.dmLosses));
  }

  // Update Last_Match for both players
  updates.push({
    range: `${LADDER_TAB}!${colLetter(COL.lastMatch)}${winnerRow}`,
    values: [[today]],
  });
  updates.push({
    range: `${LADDER_TAB}!${colLetter(COL.lastMatch)}${loserRow}`,
    values: [[today]],
  });

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: config.google.sheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: updates,
    },
  });
}
