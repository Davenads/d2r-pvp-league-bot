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
export interface DeathmatchAlternatives {
  build: string;
  alternatives: string[];  // up to 5
}

// ── Cache key helpers ────────────────────────────────────────────────────────

export const CacheKeys = {
  banned: () => 'd2r:banned',
  deathmatch: (build: string) => `d2r:deathmatch:${build}`,
  deathmatches: () => 'd2r:deathmatches',
  rulesGeneral: () => 'd2r:rules:general',
  classRules: () => 'd2r:rules:class',
  faq: () => 'd2r:faq',
  ladder: () => 'd2r:ladder',
  // Queue / match state
  queue: () => 'd2r:queue',
  playerState: (discordId: string) => `d2r:player:${discordId}:state`,
  // Concurrent match support — Redis SET of active match IDs (as strings) per player
  activeMatchSet: (discordId: string) => `d2r:matches:active:${discordId}`,
  farmingPair: (a: string, b: string) => {
    const [x, y] = [a, b].sort();
    return `d2r:farming:${x}:${y}`;
  },
  mirrorRequest: (nonce: string) => `d2r:mirror:req:${nonce}`,
  // Forced match assignment (set by scheduler, cleared by /im-ready)
  forcedMatch: (discordId: string) => `d2r:forced:${discordId}`,
  // Forced match notification thread ID (set by scheduler, cleared on queue join)
  forcedMatchThread: (discordId: string) => `d2r:forced:thread:${discordId}`,
  // Ready check — per-player click count and last-click timestamp per match
  matchRcCount:   (matchId: number, discordId: string) => `d2r:match:rc:${matchId}:${discordId}`,
  matchRcLast:    (matchId: number, discordId: string) => `d2r:match:rc:last:${matchId}:${discordId}`,
  // Extend match — pending request and one-extension flag per match
  matchExtendReq: (matchId: number) => `d2r:match:extend:req:${matchId}`,
  matchExtended:  (matchId: number) => `d2r:match:extended:${matchId}`,
  // Leaderboard — stores the Discord message ID of the pinned standings embed
  leaderboardMsgId: () => 'd2r:leaderboard:msgid',
  // Queue button — stores the Discord message ID of the persistent Join Queue embed
  queueBtnMsgId: () => 'd2r:queue:btn:msgid',
  // Action panel — stores the Discord message ID of the Register/Join Queue panel in the leaderboard channel
  actionPanelMsgId: () => 'd2r:action:panel:msgid',
  // Info hub — stores JSON { channelId, messageId } of the persistent rules/info hub post
  infoHubMsgId: () => 'd2r:info:hub:msgid',
  // Per-player distributed lock to prevent duplicate queue join processing
  queueJoinLock: (discordId: string) => `d2r:queue:join:lock:${discordId}`,
  // Per-pair lock to prevent duplicate override_banned match creation from simultaneous clicks
  overrideLock: (p1Id: string, p2Id: string) => {
    const [a, b] = [p1Id, p2Id].sort();
    return `d2r:override:lock:${a}:${b}`;
  },
} as const;

// ── Mirror request type ───────────────────────────────────────────────────────

export interface MirrorRequest {
  requesterId: string;    // Discord ID
  opponentId: string;     // Discord ID
  build: string;          // The mirror build both players will use
}

// ── Queue / match state types ────────────────────────────────────────────────

export type PlayerQueueState = 'idle' | 'queued' | 'in_match';

/** A build pairing candidate — includes match type for deathmatch detection */
export interface BuildPairing {
  build1: string;
  build2: string;
  type?: 'STANDARD' | 'DEATHMATCH';
}

/**
 * Returned by joinQueue / admin-forcematch when two players are matched.
 * Prisma Match record is created immediately on match; no pending selection needed.
 */
export interface MatchFound {
  matched: true;
  opponentDiscordId: string;
  matchId: number;                                        // Prisma Match.id (created immediately)
  selectedMatchup: { build1: string; build2: string };   // randomly chosen pairing
  matchType: 'STANDARD' | 'DEATHMATCH';                  // pairing type
  allBanned: boolean;                                     // true if override flow was triggered
}
