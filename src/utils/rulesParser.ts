import { EmbedBuilder } from 'discord.js';
import { CLASS_EMOJIS, ALL_CLASS_EMOJIS, CAIN_EMOJI } from './classEmojis.js';
import { EMBED_COLORS } from './formatters.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const SEP = '——————————————————————————————';
const MAX_DESC = 4000; // conservative buffer below the 4096-char Discord limit

// ── Header map ────────────────────────────────────────────────────────────────

/**
 * Maps normalised header text (lowercase, colon stripped) to the label and
 * emoji shown in the embed. Supports both bare class names ("druid") and
 * suffixed forms ("druid rules") so moderator edits to the sheet header style
 * do not break lookups.
 */
interface HeaderEntry {
  label: string;
  emoji: string;
}

const HEADER_MAP: Record<string, HeaderEntry> = {
  'general rules':    { label: 'GENERAL RULES',  emoji: '⚙️' },
  'map rules':        { label: 'MAP RULES',       emoji: '🗺️' },
  'item rules':       { label: 'ITEM RULES',      emoji: '🎯' },
  'druid':            { label: 'DRUID',            emoji: CLASS_EMOJIS['Druid'] ?? '' },
  'druid rules':      { label: 'DRUID',            emoji: CLASS_EMOJIS['Druid'] ?? '' },
  'necromancer':      { label: 'NECROMANCER',      emoji: CLASS_EMOJIS['Necromancer'] ?? '' },
  'necromancer rules':{ label: 'NECROMANCER',      emoji: CLASS_EMOJIS['Necromancer'] ?? '' },
  'barbarian':        { label: 'BARBARIAN',        emoji: CLASS_EMOJIS['Barbarian'] ?? '' },
  'barbarian rules':  { label: 'BARBARIAN',        emoji: CLASS_EMOJIS['Barbarian'] ?? '' },
  'assassin':         { label: 'ASSASSIN',         emoji: CLASS_EMOJIS['Assassin'] ?? '' },
  'assassin rules':   { label: 'ASSASSIN',         emoji: CLASS_EMOJIS['Assassin'] ?? '' },
  'paladin':          { label: 'PALADIN',          emoji: CLASS_EMOJIS['Paladin'] ?? '' },
  'paladin rules':    { label: 'PALADIN',          emoji: CLASS_EMOJIS['Paladin'] ?? '' },
  'amazon':           { label: 'AMAZON',           emoji: CLASS_EMOJIS['Amazon'] ?? '' },
  'amazon rules':     { label: 'AMAZON',           emoji: CLASS_EMOJIS['Amazon'] ?? '' },
  'sorceress':        { label: 'SORCERESS',        emoji: CLASS_EMOJIS['Sorceress'] ?? '' },
  'sorceress rules':  { label: 'SORCERESS',        emoji: CLASS_EMOJIS['Sorceress'] ?? '' },
};

// ── Section type ──────────────────────────────────────────────────────────────

interface Section {
  label: string;
  emoji: string;
  rules: string[];
}

// ── Header detection ──────────────────────────────────────────────────────────

/**
 * Returns true if the line should be treated as a section header.
 * Primary signal: line ends with `:`.
 * Fallback: line exactly matches a known header keyword (no colon required).
 */
function isHeader(line: string): boolean {
  if (line.endsWith(':')) return true;
  return line.trim().toLowerCase() in HEADER_MAP;
}

/**
 * Resolves a header line to its label and emoji.
 * Falls back to an uppercased version of the raw text with a generic emoji
 * so that unknown sections (added by mods) still display cleanly.
 */
function resolveHeader(line: string): HeaderEntry {
  const key = line.replace(/:$/, '').trim().toLowerCase();
  return HEADER_MAP[key] ?? {
    label: line.replace(/:$/, '').trim().toUpperCase(),
    emoji: '📋',
  };
}

// ── URL detection ─────────────────────────────────────────────────────────────

const URL_REGEX = /^https?:\/\/\S+$/;

function isRawUrl(bullet: string): boolean {
  return URL_REGEX.test(bullet.replace(/^•\s*/, '').trim());
}

function extractUrl(bullet: string): string {
  return bullet.replace(/^•\s*/, '').trim();
}

/**
 * Post-processing pass on a section's rule array.
 * When a non-URL bullet is immediately followed by a URL-only bullet,
 * the pair is merged into a Discord markdown hyperlink: [label](url).
 */
function mergeTextUrlPairs(rules: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < rules.length) {
    const current = rules[i];
    const next = rules[i + 1];
    if (next && !isRawUrl(current) && isRawUrl(next)) {
      const label = current.replace(/^•\s*/, '').trim();
      const url = extractUrl(next);
      out.push(`• [${label}](${url})`);
      i += 2; // consume both
    } else {
      out.push(current);
      i++;
    }
  }
  return out;
}

// ── Parsing ───────────────────────────────────────────────────────────────────

/**
 * Converts a flat list of rule lines (from the sheet cache) into an ordered
 * array of Sections. Lines ending with `:` (or matching a known keyword) are
 * treated as section headers; all other lines become bullet entries under the
 * current section.
 */
export function parseRulesIntoSections(lines: string[]): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;

  for (const line of lines) {
    if (isHeader(line)) {
      if (current !== null) sections.push(current);
      const entry = resolveHeader(line);
      current = { label: entry.label, emoji: entry.emoji, rules: [] };
    } else {
      if (current === null) {
        // Lines appearing before any header — group under a generic preamble
        current = { label: 'RULES', emoji: '📋', rules: [] };
      }
      // Normalise bullet prefix — sheet may have plain text, dashes, or bullets
      const text = line.replace(/^[•\-–]\s*/, '').trim();
      if (text) current.rules.push(`• ${text}`);
    }
  }

  if (current !== null && current.rules.length > 0) sections.push(current);

  // Merge any text+URL pairs into Discord markdown hyperlinks
  return sections.map((s) => ({ ...s, rules: mergeTextUrlPairs(s.rules) }));
}

// ── Rendering helpers ─────────────────────────────────────────────────────────

function renderSection(section: Section): string {
  return [`${section.emoji} **${section.label}**`, ...section.rules].join('\n');
}

// ── Embed pagination ──────────────────────────────────────────────────────────

/**
 * Paginates an array of Sections into one or more Discord EmbedBuilders,
 * respecting the 4096-character description limit.
 *
 * Page 1 includes the class emoji banner above the first section.
 * A horizontal separator is inserted between sections on the same page.
 * The final embed carries a footer pointing users to /matchup.
 */
export function buildRulesEmbeds(
  sections: Section[],
  variant: 'rules' | 'test-rules',
): EmbedBuilder[] {
  const mainTitle = variant === 'rules'
    ? `${CAIN_EMOJI} D2R 1v1 League — Official Rules`
    : `${CAIN_EMOJI} D2R 1v1 League — Test Rules`;
  const contTitle = variant === 'rules'
    ? `${CAIN_EMOJI} Rules (continued)`
    : `${CAIN_EMOJI} Test Rules (continued)`;
  const footerText = 'Use /matchup <build> <build> for matchup-specific rules.';
  const preamble = `${ALL_CLASS_EMOJIS}\n\n`;

  const pages: string[] = [];
  let currentPage = '';

  for (const section of sections) {
    const rendered = renderSection(section);

    if (currentPage === '') {
      // First section on a new page
      const prefix = pages.length === 0 ? preamble : '';
      currentPage = prefix + rendered;
    } else {
      const candidate = `${currentPage}\n\n${SEP}\n\n${rendered}`;
      if (candidate.length > MAX_DESC) {
        // Current page is full — flush it and start fresh
        pages.push(currentPage);
        currentPage = rendered;
      } else {
        currentPage = candidate;
      }
    }
  }

  if (currentPage) pages.push(currentPage);

  return pages.map((desc, i) =>
    new EmbedBuilder()
      .setColor(EMBED_COLORS.rules)
      .setTitle(i === 0 ? mainTitle : contTitle)
      .setDescription(desc)
      .setFooter(i === pages.length - 1 ? { text: footerText } : null),
  );
}
