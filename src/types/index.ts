import { ChatInputCommandInteraction, AutocompleteInteraction, SlashCommandBuilder } from 'discord.js';
import type { SlashCommandOptionsOnlyBuilder } from 'discord.js';

// ── Command shape ────────────────────────────────────────────────────────────

export interface Command {
  data: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder | Omit<SlashCommandBuilder, 'addSubcommand' | 'addSubcommandGroup'>;
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
  build: string;
  build2?: string;
  wins: number;
  losses: number;
  winPct: number;
  points: number;
  trWins: number;
  trLosses: number;
  trWinPct: number;
  dmWins: number;
  dmLosses: number;
  status: 'Active' | 'Inactive' | 'DQ';
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
  faq: () => 'd2r:faq',
  ladder: () => 'd2r:ladder',
} as const;
