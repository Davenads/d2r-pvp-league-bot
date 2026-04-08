/**
 * Discord application emoji strings for each D2R character class.
 * Format: <:emojiname:emojiid>
 */
export const CLASS_EMOJIS: Record<string, string> = {
  Amazon:      '<:amazonemoji:1491565082176655540>',
  Assassin:    '<:assassinemoji:1491565077181108315>',
  Barbarian:   '<:barbemoji:1491565083472691362>',
  Druid:       '<:druidemoji:1491565078783332384>',
  Necromancer: '<:necromanceremoji:1491565080007934013>',
  Paladin:     '<:paladinemoji:1491565081144594502>',
  Sorceress:   '<:sorceressemoji:1491565075868160000>',
} as const;

/**
 * All 7 class emojis joined as a display row (e.g. for embed headers).
 */
export const ALL_CLASS_EMOJIS = Object.values(CLASS_EMOJIS).join(' ');

/**
 * Returns the Discord emoji string for a given canonical build name.
 * Build names follow the pattern "ClassName - BuildVariant".
 * Returns empty string if the class is not recognised.
 */
export function getClassEmoji(buildName: string): string {
  const className = buildName.split(' - ')[0]?.trim() ?? '';
  return CLASS_EMOJIS[className] ?? '';
}
