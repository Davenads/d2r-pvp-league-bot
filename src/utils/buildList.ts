/** Canonical build names — must match sheet row/column headers exactly */
export const CANONICAL_BUILDS: readonly string[] = [
  'Amazon - CS Hybrid Bowa',
  'Amazon - CS Zon',
  'Amazon - Telebow',
  'Amazon - Walkbow',
  'Assassin - Ghost',
  'Assassin - Hybrid',
  'Assassin - Spider',
  'Assassin - Trapper',
  'Barbarian - BvA',
  'Barbarian - BvC',
  'Barbarian - Throw/WW Hybrid',
  'Druid - Fire Druid',
  'Druid - Shaman',
  'Druid - Windy',
  'Necromancer - Bone',
  'Paladin - Charger',
  'Paladin - Hammerdin',
  'Paladin - T/V',
  'Paladin - V/C',
  'Paladin - V/T',
  'Sorceress - Cold ES',
  'Sorceress - Cold Vita',
  'Sorceress - Fire ES',
  'Sorceress - Fire Vita',
  'Sorceress - Lite ES',
  'Sorceress - Lite Vita',
] as const;

/**
 * Alias map: lowercase alias → canonical build name.
 * Add entries freely; keep lowercase keys.
 */
const BUILD_ALIASES: Record<string, string> = {
  // Amazon
  'csbowa': 'Amazon - CS Hybrid Bowa',
  'hybowa': 'Amazon - CS Hybrid Bowa',
  'cshybrid': 'Amazon - CS Hybrid Bowa',
  'cszon': 'Amazon - CS Zon',
  'java': 'Amazon - CS Zon',
  'javazon': 'Amazon - CS Zon',
  'telebow': 'Amazon - Telebow',
  'walkbow': 'Amazon - Walkbow',
  // Assassin
  'ghost': 'Assassin - Ghost',
  'ghostsin': 'Assassin - Ghost',
  'hybrid': 'Assassin - Hybrid',
  'hybsin': 'Assassin - Hybrid',
  'spider': 'Assassin - Spider',
  'spidersin': 'Assassin - Spider',
  'trapper': 'Assassin - Trapper',
  'trapsin': 'Assassin - Trapper',
  // Barbarian
  'bva': 'Barbarian - BvA',
  'shieldbarb': 'Barbarian - BvA',
  'bvc': 'Barbarian - BvC',
  'throwbarb': 'Barbarian - Throw/WW Hybrid',
  'wwbarb': 'Barbarian - Throw/WW Hybrid',
  'throwww': 'Barbarian - Throw/WW Hybrid',
  // Druid
  'firedruid': 'Druid - Fire Druid',
  'fd': 'Druid - Fire Druid',
  'shaman': 'Druid - Shaman',
  'windy': 'Druid - Windy',
  'winddruid': 'Druid - Windy',
  // Necromancer
  'bone': 'Necromancer - Bone',
  'necro': 'Necromancer - Bone',
  'boner': 'Necromancer - Bone',
  // Paladin
  'charger': 'Paladin - Charger',
  'hammerdin': 'Paladin - Hammerdin',
  'hdin': 'Paladin - Hammerdin',
  'tv': 'Paladin - T/V',
  't/v': 'Paladin - T/V',
  'vc': 'Paladin - V/C',
  'v/c': 'Paladin - V/C',
  'vt': 'Paladin - V/T',
  'v/t': 'Paladin - V/T',
  // Sorceress
  'coldes': 'Sorceress - Cold ES',
  'ces': 'Sorceress - Cold ES',
  'coldvita': 'Sorceress - Cold Vita',
  'cv': 'Sorceress - Cold Vita',
  'firees': 'Sorceress - Fire ES',
  'fes': 'Sorceress - Fire ES',
  'firevita': 'Sorceress - Fire Vita',
  'fv': 'Sorceress - Fire Vita',
  'litees': 'Sorceress - Lite ES',
  'les': 'Sorceress - Lite ES',
  'litevita': 'Sorceress - Lite Vita',
  'lv': 'Sorceress - Lite Vita',
};

/**
 * Resolves a user-provided string to a canonical build name.
 * Checks exact match first, then alias map, then case-insensitive prefix match.
 * Returns undefined if no match found.
 */
export function resolveBuild(input: string): string | undefined {
  // Exact match
  if (CANONICAL_BUILDS.includes(input as typeof CANONICAL_BUILDS[number])) return input;

  // Alias map (normalize to lowercase, strip spaces)
  const normalized = input.toLowerCase().replace(/\s+/g, '');
  if (BUILD_ALIASES[normalized]) return BUILD_ALIASES[normalized];

  // Case-insensitive prefix match against canonical list
  const lower = input.toLowerCase();
  const prefixMatch = CANONICAL_BUILDS.find((b) => b.toLowerCase().startsWith(lower));
  if (prefixMatch) return prefixMatch;

  // Substring match as last resort
  return CANONICAL_BUILDS.find((b) => b.toLowerCase().includes(lower));
}

/**
 * Returns autocomplete choices filtered by the partial input.
 * Limits to 25 results (Discord autocomplete max).
 */
export function getBuildChoices(partial: string): Array<{ name: string; value: string }> {
  const lower = partial.toLowerCase();
  return CANONICAL_BUILDS
    .filter((b) => b.toLowerCase().includes(lower))
    .slice(0, 25)
    .map((b) => ({ name: b, value: b }));
}
