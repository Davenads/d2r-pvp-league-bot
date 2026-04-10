/**
 * Ladder service — handles W/L write-back to the Google Sheets Ladder tab
 * on match confirmation.
 *
 * Column layout (0-indexed from A):
 *   A=0 Rank | B=1 Discord_Username | C=2 Discord_UUID
 *   D=3 Build_1 | E=4 Build_2 | F=5 Build_3 | G=6 Build_4 | H=7 Build_5
 *   I=8 W | J=9 L | K=10 W% | L=11 Points
 *   M=12 TR_W | N=13 TR_L | O=14 TR_W%
 *   P=15 DM_W | Q=16 DM_L | R=17 Status | S=18 Last_Match | T=19 Registered | U=20 Notes
 */

import { google, sheets_v4 } from 'googleapis';
import { config, resolveGoogleCredentials } from '../config.js';
import { MatchType } from '@prisma/client';
import { abbreviateBuild } from '../utils/buildList.js';

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
  build1:      3,   // D
  build2:      4,   // E
  build3:      5,   // F
  build4:      6,   // G
  build5:      7,   // H
  wins:        8,   // I
  losses:      9,   // J
  trWins:     12,   // M
  trLosses:   13,   // N
  dmWins:     15,   // P
  dmLosses:   16,   // Q
  status:     17,   // R
  lastMatch:  18,   // S
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
    range: `${LADDER_TAB}!A:U`,
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
 * Column order (A–U):
 *   A Rank | B Discord_Username | C Discord_UUID
 *   D Build_1 | E Build_2 | F Build_3 | G Build_4 | H Build_5
 *   I Wins | J Losses | K Win% | L Points
 *   M TR_W | N TR_L | O TR_W%
 *   P DM_W | Q DM_L | R Status | S Last_Match | T Registered | U Notes
 */
export async function addPlayerToLadder(
  discordId: string,
  discordUsername: string,
  builds: string[],  // 2–5 builds; builds[0] = primary, builds[1] = secondary, etc.
): Promise<void> {
  const sheets = getWriteClient();
  const today = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });

  // A full row seeded with zeros for stat columns; formula columns left blank
  const row = [
    '',              // A — Rank (sheet formula)
    discordUsername, // B — Discord_Username
    discordId,       // C — Discord_UUID
    builds[0] ? abbreviateBuild(builds[0]) : '', // D — Build_1
    builds[1] ? abbreviateBuild(builds[1]) : '', // E — Build_2
    builds[2] ? abbreviateBuild(builds[2]) : '', // F — Build_3
    builds[3] ? abbreviateBuild(builds[3]) : '', // G — Build_4
    builds[4] ? abbreviateBuild(builds[4]) : '', // H — Build_5
    0,               // I — Wins
    0,               // J — Losses
    '',              // K — Win% (sheet formula)
    '',              // L — Points (sheet formula)
    0,               // M — TR_W
    0,               // N — TR_L
    '',              // O — TR_W% (sheet formula)
    0,               // P — DM_W
    0,               // Q — DM_L
    'Available',     // R — Status
    '',              // S — Last_Match
    today,           // T — Registered
    '',              // U — Notes
  ];

  // Determine the true next empty row by scanning for the last row with a Discord UUID
  // in column C. This avoids the Sheets `append` phantom-row problem where formatting or
  // data-validation rules extending far down the sheet cause `append` to write at row 1000+.
  const rows = await fetchLadderRaw();
  let lastDataIdx = 0; // 0-based array index of last row with real player data (0 = header)
  for (let i = rows.length - 1; i >= 1; i--) {
    if (rows[i]?.[COL.discordUuid]?.trim()) {
      lastDataIdx = i;
      break;
    }
  }
  // rows[i] corresponds to sheet row i+1; next empty row is lastDataIdx+2
  const nextSheetRow = lastDataIdx + 2;

  await sheets.spreadsheets.values.update({
    spreadsheetId: config.google.sheetId,
    range: `${LADDER_TAB}!A${nextSheetRow}:U${nextSheetRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  });
  console.log(`[Ladder] addPlayerToLadder: wrote row ${nextSheetRow} for ${discordId} (${discordUsername})`);
}

/**
 * Reactivates a previously removed player's existing Ladder sheet row.
 * Updates Discord_Username (B), Build1 (D), Build2 (E), and Status (O) in place.
 * Used when a removed player re-registers rather than appending a duplicate row.
 */
export async function reactivatePlayerOnLadder(
  discordId: string,
  discordUsername: string,
  builds: string[],  // 2–5 builds
): Promise<void> {
  const sheets = getWriteClient();
  const rows = await fetchLadderRaw();
  const sheetRow = findPlayerRow(rows, discordId);

  if (!sheetRow) {
    // Row doesn't exist (edge case) — fall back to appending a fresh row
    console.warn(`[Ladder] reactivatePlayerOnLadder: row not found for ${discordId}, appending fresh row`);
    await addPlayerToLadder(discordId, discordUsername, builds);
    return;
  }

  const updates: sheets_v4.Schema$ValueRange[] = [
    { range: `${LADDER_TAB}!B${sheetRow}`, values: [[discordUsername]] },
    { range: `${LADDER_TAB}!D${sheetRow}`, values: [[builds[0] ? abbreviateBuild(builds[0]) : '']] },
    { range: `${LADDER_TAB}!E${sheetRow}`, values: [[builds[1] ? abbreviateBuild(builds[1]) : '']] },
    { range: `${LADDER_TAB}!F${sheetRow}`, values: [[builds[2] ? abbreviateBuild(builds[2]) : '']] },
    { range: `${LADDER_TAB}!G${sheetRow}`, values: [[builds[3] ? abbreviateBuild(builds[3]) : '']] },
    { range: `${LADDER_TAB}!H${sheetRow}`, values: [[builds[4] ? abbreviateBuild(builds[4]) : '']] },
    { range: `${LADDER_TAB}!${colLetter(COL.status)}${sheetRow}`, values: [['Available']] },
  ];

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: config.google.sheetId,
    requestBody: { valueInputOption: 'USER_ENTERED', data: updates },
  });
  console.log(`[Ladder] reactivatePlayerOnLadder: updated sheet row ${sheetRow} for ${discordId} (${discordUsername})`);
}

/**
 * Updates the Status column (O) for a player row in the Ladder sheet.
 * Used to mark a player as "Removed" without deleting their row.
 * No-ops silently if the player is not found in the sheet.
 */
export async function updatePlayerLadderStatus(
  discordId: string,
  status: 'Available' | 'Vacation' | 'Removed',
): Promise<void> {
  const sheets = getWriteClient();
  const rows = await fetchLadderRaw();
  const sheetRow = findPlayerRow(rows, discordId);

  if (!sheetRow) {
    console.warn(`[Ladder] updatePlayerLadderStatus: row not found for ${discordId}`);
    return;
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: config.google.sheetId,
    range: `${LADDER_TAB}!${colLetter(COL.status)}${sheetRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[status]] },
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
