import { EmbedBuilder, Colors } from 'discord.js';
import type { MatchupRules, LadderEntry } from '../types/index.js';
import { getClassEmoji, CAIN_EMOJI } from './classEmojis.js';

export { getClassEmoji, CAIN_EMOJI } from './classEmojis.js';

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
  const emojiA = getClassEmoji(buildA);
  const emojiB = getClassEmoji(buildB);
  const labelA = emojiA ? `${emojiA} ${buildA}` : buildA;
  const labelB = emojiB ? `${emojiB} ${buildB}` : buildB;
  return new EmbedBuilder()
    .setColor(EMBED_COLORS.banned)
    .setTitle(`${CAIN_EMOJI} Banned Matchup`)
    .setDescription(
      `**${labelA}** vs **${labelB}** is a **banned matchup** and cannot be played in the regular season.\n\nCheck \`/deathmatch\` for alternative opponents.`
    );
}

export function buildMatchupEmbed(rules: MatchupRules): EmbedBuilder {
  const emojiA = getClassEmoji(rules.buildA);
  const emojiB = getClassEmoji(rules.buildB);
  const labelA = emojiA ? `${emojiA} ${rules.buildA}` : rules.buildA;
  const labelB = emojiB ? `${emojiB} ${rules.buildB}` : rules.buildB;

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLORS.rules)
    .setTitle(`${CAIN_EMOJI} ${labelA}  vs  ${labelB}`)
    .setFooter({ text: 'Rules sourced from D2R 1v1 League ruleset. Use /rules for general rules.' });

  embed.addFields({
    name: `${emojiA ? emojiA + ' ' : ''}${rules.buildA} Rules`,
    value: rules.rulesForA || '*No specific restrictions.*',
    inline: false,
  });

  embed.addFields({
    name: `${emojiB ? emojiB + ' ' : ''}${rules.buildB} Rules`,
    value: rules.rulesForB || '*No specific restrictions.*',
    inline: false,
  });

  return embed;
}

// ── Ladder embed ─────────────────────────────────────────────────────────────

export function buildLadderEmbed(entries: LadderEntry[], page: number, totalPages: number): EmbedBuilder {
  const rows = entries
    .map((e) => `**#${e.rank}** ${e.discordUsername}`)
    .join('\n');

  return new EmbedBuilder()
    .setColor(EMBED_COLORS.ladder)
    .setTitle(`${CAIN_EMOJI} D2R 1v1 League Standings`)
    .setDescription(rows || '*No ladder entries found.*')
    .setFooter({ text: `Page ${page} of ${totalPages}` });
}

// ── Registration embeds ──────────────────────────────────────────────────────

export function buildRegistrationEmbed(
  discordUsername: string,
  discordId: string,
  builds: string[],  // 2–5 canonical build names
): EmbedBuilder {
  const buildList = builds
    .map((b) => {
      const emoji = getClassEmoji(b);
      return emoji ? `${emoji} ${b}` : b;
    })
    .join('\n');
  return new EmbedBuilder()
    .setColor(EMBED_COLORS.success)
    .setTitle(`${CAIN_EMOJI} New Player Registered`)
    .setDescription(`<@${discordId}> has joined the D2R 1v1 League!`)
    .addFields({ name: 'Registered Builds', value: buildList, inline: false })
    .setFooter({ text: `Discord: ${discordUsername}` })
    .setTimestamp();
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
