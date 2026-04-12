import { ChatInputCommandInteraction, AutocompleteInteraction, SlashCommandBuilder } from 'discord.js';
import type { SlashCommandOptionsOnlyBuilder, SlashCommandSubcommandsOnlyBuilder } from 'discord.js';

// ── Command shape ────────────────────────────────────────────────────────────

export interface Command {
  data:
    | SlashCommandBuilder
    | SlashCommandOptionsOnlyBuilder
    | SlashCommandSubcommandsOnlyBuilder
    | Omit<SlashCommandBuilder, 'addSubcommand' | 'addSubcommandGroup'>;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
}

// ── Google Sheets data shapes ────────────────────────────────────────────────

/** A single cell value from the Matchups matrix */
export interface MatchupRules {
  buildA: string;
  buildB: string;
  rulesForA: string;  // cell [buildA row][buildB col]
  rulesForB: string;  // cell [buildB row][buildA col]
  isBanned: boolean;
}

/** One row from the Ladder tab */
export interface LadderEntry {
  rank: number;
  discordUsername: string;
  discordId: string;
  build1: string;
  build2?: string;
  build3?: string;
  build4?: string;
  build5?: string;
  wins: number;
  losses: number;
  winPct: number;
  points: number;
  trWins: number;
  trLosses: number;
  trWinPct: number;
  dmWins: number;
  dmLosses: number;
  status: 'Available' | 'Vacation';
  lastMatch: string;
  registered: string;
  notes?: string;
}

/** Deathmatch alternatives for a given build */
export interface DeathmatcAlternatives {
  build: string;
  alternatives: string[];  // up to 5
}

// ── Cache key helpers ────────────────────────────────────────────────────────

export const CacheKeys = {
  matchup: (a: string, b: string) => {
    const [x, y] = [a, b].sort();
    return `d2r:matchup:${x}:${y}`;
  },
  banned: () => 'd2r:banned',
  deathmatch: (build: string) => `d2r:deathmatch:${build}`,
  rulesGeneral: () => 'd2r:rules:general',
  rulesTest: () => 'd2r:rules:test',
  faq: () => 'd2r:faq',
  ladder: () => 'd2r:ladder',
  // Queue / match state
  queue: () => 'd2r:queue',
  playerState: (discordId: string) => `d2r:player:${discordId}:state`,
  activeMatch: (discordId: string) => `d2r:match:active:${discordId}`,
  farmingPair: (a: string, b: string) => {
    const [x, y] = [a, b].sort();
    return `d2r:farming:${x}:${y}`;
  },
  mirrorRequest: (nonce: string) => `d2r:mirror:req:${nonce}`,
  // Forced match assignment (set by scheduler, cleared by /im-ready)
  forcedMatch: (discordId: string) => `d2r:forced:${discordId}`,
  // Pending matchup selection (stored until both players confirm a build pairing)
  pendingMatch: (nonce: string) => `d2r:pending:${nonce}`,
} as const;

// ── Mirror request type ───────────────────────────────────────────────────────

export interface MirrorRequest {
  requesterId: string;    // Discord ID
  opponentId: string;     // Discord ID
  build: string;          // The mirror build both players will use
}

// ── Queue / match state types ────────────────────────────────────────────────

export type PlayerQueueState = 'idle' | 'queued' | 'in_match';

export interface ActiveMatchState {
  matchId: number;             // Postgres Match.id
  player1DiscordId: string;
  player2DiscordId: string;
  build1: string;              // player1's build for this match
  build2: string;              // player2's build for this match
  threadId?: string;           // filled in after thread creation
  createdAt: number;           // unix ms
}

/** A build pairing candidate for matchup selection */
export interface BuildPairing {
  build1: string;
  build2: string;
}

/**
 * Returned by joinQueue / admin-forcematch when two players are matched.
 * No Prisma record is created yet — awaiting matchup selection confirmation.
 */
export interface MatchFound {
  matched: true;
  nonce: string;
  opponentDiscordId: string;
  availableMatchups: BuildPairing[];  // non-banned pairings
  allMatchups: BuildPairing[];        // all NxM combinations
  allBanned: boolean;                 // true if all pairings are banned
}

/**
 * Transient state stored in Redis while two players are choosing a matchup.
 * Cleared once the matchup is confirmed (Prisma record created) or cancelled.
 */
export interface PendingMatchSelection {
  nonce: string;
  seasonId: number;
  player1DiscordId: string;
  player2DiscordId: string;
  player1DbId: number;
  player2DbId: number;
  availableMatchups: BuildPairing[];
  allMatchups: BuildPairing[];
  allBanned: boolean;
  threadId?: string;
  matchType: 'STANDARD' | 'TOURNAMENT';
  createdAt: number;
  selectedMatchup?: BuildPairing;
  selectorDiscordId?: string;
}
