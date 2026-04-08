import { EmbedBuilder, Colors } from 'discord.js';
import type { MatchupRules, LadderEntry } from '../types/index.js';

// ── Colour palette ───────────────────────────────────────────────────────────

export const EMBED_COLORS = {
  info: Colors.Blue,
  success: Colors.Green,
  warning: Colors.Yellow,
  error: Colors.Red,
  banned: Colors.DarkRed,
  rules: 0x8B4513,  // earthy brown — on-theme for D2
  ladder: Colors.Gold,
} as const;

// ── Matchup embeds ───────────────────────────────────────────────────────────

export function buildBannedMatchupEmbed(buildA: string, buildB: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(EMBED_COLORS.banned)
    .setTitle('Banned Matchup')
    .setDescription(
      `**${buildA}** vs **${buildB}** is a **banned matchup** and cannot be played in the regular season.\n\nCheck \`/deathmatch\` for alternative opponents.`
    );
}

export function buildMatchupEmbed(rules: MatchupRules): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLORS.rules)
    .setTitle(`${rules.buildA} vs ${rules.buildB}`)
    .setFooter({ text: 'Rules sourced from D2R 1v1 League ruleset. Use /rules for general rules.' });

  if (rules.rulesForA) {
    embed.addFields({ name: `${rules.buildA} Rules`, value: rules.rulesForA, inline: false });
  } else {
    embed.addFields({ name: `${rules.buildA} Rules`, value: '*No specific restrictions.*', inline: false });
  }

  if (rules.rulesForB) {
    embed.addFields({ name: `${rules.buildB} Rules`, value: rules.rulesForB, inline: false });
  } else {
    embed.addFields({ name: `${rules.buildB} Rules`, value: '*No specific restrictions.*', inline: false });
  }

  return embed;
}

// ── Ladder embed ─────────────────────────────────────────────────────────────

export function buildLadderEmbed(entries: LadderEntry[], page: number, totalPages: number): EmbedBuilder {
  const rows = entries
    .map((e) => {
      const pct = (e.winPct * 100).toFixed(1);
      return `**${e.rank}.** ${e.discordUsername} (${e.build}) — ${e.wins}W / ${e.losses}L (${pct}%) — ${e.points}pts`;
    })
    .join('\n');

  return new EmbedBuilder()
    .setColor(EMBED_COLORS.ladder)
    .setTitle('D2R 1v1 League Standings')
    .setDescription(rows || '*No ladder entries found.*')
    .setFooter({ text: `Page ${page} of ${totalPages}` });
}

// ── Generic error embed ──────────────────────────────────────────────────────

export function buildErrorEmbed(message: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(EMBED_COLORS.error)
    .setTitle('Error')
    .setDescription(message);
}

export function buildUnavailableEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(EMBED_COLORS.warning)
    .setTitle('Data Temporarily Unavailable')
    .setDescription('Could not reach the rules sheet. Please try again in a moment. If this persists, contact a mod.');
}
