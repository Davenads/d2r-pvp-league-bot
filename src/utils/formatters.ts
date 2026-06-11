import { EmbedBuilder, Colors, escapeMarkdown } from 'discord.js';
import type { LadderEntry } from '../types/index.js';
import type { ClassRulesEntry } from '../services/content.js';
import { getClassEmoji, CLASS_EMOJIS, CAIN_EMOJI } from './classEmojis.js';

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

// ── Class rules embed ─────────────────────────────────────────────────────────

const CLASS_RULES_SEP = '——————————————————————————————';
const MAX_CLASS_EMBED_DESC = 4000;

/**
 * Builds one or two EmbedBuilders for a single class's rules.
 * Regular rules are shown first; if test rules exist they follow after a
 * horizontal separator and a TEST RULES header, all within the same embed.
 * Returns two embeds only if the combined description exceeds Discord's limit.
 */
export function buildClassRulesEmbed(
  className: string,
  entry: ClassRulesEntry,
): EmbedBuilder[] {
  const emoji = CLASS_EMOJIS[className] ?? '';
  const title = emoji
    ? `${CAIN_EMOJI} ${emoji} ${className} — Class Rules`
    : `${CAIN_EMOJI} ${className} — Class Rules`;

  const regularLines = entry.rules.map((r) => `• ${r}`);
  const testLines = entry.testRules.map((r) => `• ${r}`);

  let description = regularLines.join('\n') || '*No rules listed.*';
  if (testLines.length > 0) {
    description += `\n\n${CLASS_RULES_SEP}\n**TEST RULES**\n${testLines.join('\n')}`;
  }

  if (description.length <= MAX_CLASS_EMBED_DESC) {
    return [
      new EmbedBuilder()
        .setColor(EMBED_COLORS.rules)
        .setTitle(title)
        .setDescription(description)
        .setFooter({ text: 'Use /rules for general league rules.' }),
    ];
  }

  // Overflow — split at the separator between regular and test rules if present
  const sepIdx = description.indexOf(CLASS_RULES_SEP);
  if (sepIdx !== -1) {
    return [
      new EmbedBuilder()
        .setColor(EMBED_COLORS.rules)
        .setTitle(title)
        .setDescription(description.slice(0, sepIdx).trim()),
      new EmbedBuilder()
        .setColor(EMBED_COLORS.rules)
        .setTitle(`${title} (continued)`)
        .setDescription(description.slice(sepIdx).trim())
        .setFooter({ text: 'Use /rules for general league rules.' }),
    ];
  }

  // Last resort: hard truncate
  return [
    new EmbedBuilder()
      .setColor(EMBED_COLORS.rules)
      .setTitle(title)
      .setDescription(description.slice(0, MAX_CLASS_EMBED_DESC))
      .setFooter({ text: 'Use /rules for general league rules.' }),
  ];
}

// ── Ladder embed ─────────────────────────────────────────────────────────────

export function buildLadderEmbed(entries: LadderEntry[], page: number, totalPages: number): EmbedBuilder {
  const sorted = [...entries].sort((a, b) => {
    const aRank = a.rank > 0 && !isNaN(a.rank) ? a.rank : Infinity;
    const bRank = b.rank > 0 && !isNaN(b.rank) ? b.rank : Infinity;
    return aRank - bRank;
  });

  const rows = sorted
    .map((e) => {
      const rankLabel = e.rank > 0 && !isNaN(e.rank) ? `#${e.rank}` : '—';
      return `**${rankLabel}** ${escapeMarkdown(e.discordUsername)}`;
    })
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
