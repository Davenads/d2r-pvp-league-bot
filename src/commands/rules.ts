import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import type { Command } from '../types/index.js';
import { EMBED_COLORS } from '../utils/formatters.js';
import { CLASS_EMOJIS, ALL_CLASS_EMOJIS } from '../utils/classEmojis.js';

const SEP = '——————————————————————————————';

// ── Rule sections ─────────────────────────────────────────────────────────────

const SECTION_GENERAL = [
  '⚙️ **GENERAL RULES**',
  '• 16:9 resolution required (e.g. 1920×1080)',
  '• Screen sharing is **mandatory** during tournament matches',
  '• Stream sniping is prohibited',
  '• All mods, hacks, and external programs are banned — **WMC is allowed**',
  '• Both players must signal the start of every duel',
  '• No offensive abilities or curses may be cast prior to duel start',
  '• Ties are null duels',
  '• Disconnect during a duel = **loss**, unless opponent agrees to redo',
  '• Accidentally using a health/rejuv/well shrine without video proof of your life = **loss of round**, unless opponent agrees to redo or continue',
].join('\n');

const SECTION_MAP = [
  '🗺️ **MAP RULES**',
  '• H Map only — map is cut based on players alive',
  '• Item spacing must be **off** when creating games',
  '• Moor must be cleared before dueling',
  '• Mana pools are allowed — you **cannot** camp mana or drink mana to deplete the pool',
  '• Duels do not stop while your opponent retrieves mana — you can be killed grabbing mana',
  '• Duels may only be paused when **no mana is available** by typing m',
].join('\n');

const SECTION_ITEMS = [
  '🎯 **ITEM RULES**',
  '• No consumables other than mana potions and arrows',
  '• No fire sorb/stack vs Assassins (75% res max)',
  '• Life replenish capped at **33**',
  '• Max resistance: **85%**',
  '• No stash prebuffing — inventory/cube only',
  '• Slow capped at **10%**',
  '• Charges allowed: Wisp/Hoto charges (Oak Sage etc.) and Enchant',
  '• iDR capped at **11** (flat Damage Reduced, not %)',
  '• Max absorb: **20%** — when using absorb (% or flat), do not exceed 80% max resistance to that element *(exception: Tgods/Phoenix)*',
  '',
  '**Banned items:** Sunder Charms, Plague RW, Doom, Crescent Moon, Blackoak Luna, Infinity, Rising Sun, and CtC Amp items',
  '',
  '**Cold Resistance Caps:**',
  '• Max **450%** cold res',
  '• Max 420% cold res with 1× Raven',
  '• Max 325% cold res with 2× Ravens',
].join('\n');

const SECTION_DRUID = [
  `${CLASS_EMOJIS['Druid']} **DRUID**`,
  '• Summons: Cannot re-BO your bear unless necessary *(Lvl 14 BO = 160 sec)*',
  '• Max **300** total cold resist if more than 1 point in Cyclone Armor *(Raven allowed)*',
  '• Max **10%** fire res vs Vita Sorc',
  '• Poison Creeper and Carrion Vine are **banned**',
  '• Block: **30% max** vs Barbarians',
  '• Summon rules: 5 Wolves allowed vs Barb, Hammerdin, Amazon, Ghost/Hybsin — **Bear only** vs all others',
].join('\n');

const SECTION_NECRO = [
  `${CLASS_EMOJIS['Necromancer']} **NECROMANCER**`,
  '• Max **13 points** in Bone Spirit',
  '• Max **1 point** in Bone Armor',
  '• NvN: Spear only, Oak is allowed',
  '• Bone Prison allowed only vs characters that can teleport',
  '• Teeth **banned** vs Druids and Paladins',
  '• Block: **30% max** vs all, **50% max** vs Assassins',
  '• **Banned skills:** Poison Nova, Bone Wall, Corpse Skills, Skeletons/Mages/Revives',
  '• **Banned curses:** Lower Resist, Iron Maiden, Decrepify, Weaken, Life Tap',
  '• Clay Golem allowed vs all except Smiter & Assassins',
].join('\n');

const SECTION_BARB = [
  `${CLASS_EMOJIS['Barbarian']} **BARBARIAN**`,
  '• Barb makes the game',
  '• Max **20%** life leech',
  '• Max **one** poison damage small charm',
].join('\n');

const SECTION_ASSASSIN = [
  `${CLASS_EMOJIS['Assassin']} **ASSASSIN**`,
  '• No Mosaic Sins',
  '• Max **66%** Open Wounds (Fury)',
  '• Max **6%** life leech if using Whirlwind',
  '• Griffon Sins: Charged Bolt Sentry limited to **14 hard points**; light facets are **banned**',
  '• Dual Claw Sins with more than 1 hard point in Lightning Sentry cannot use absorb or +max resist; those without may use +5 max resist **or** 20 absorb, not both',
  '• Hybsin (Assassin with 1+ hard points in LS who uses Chaos): cannot use Shadow Master vs anything except Trapsin, Necromancer, and Sorceress; trap skillers are **banned**',
  '• **Shadow Master banned vs:** Barb, Paladin, Druid',
  '• Block: **63% max** vs all, **75% max** vs Amazon',
].join('\n');

const SECTION_PALADIN = [
  `${CLASS_EMOJIS['Paladin']} **PALADIN**`,
  '• Conviction is **banned**',
  '• Paladin may use 100% Open Wounds',
  '• 1 piece of Life Tap allowed',
  '• Waterwalks allowed vs Assassin',
  '• Holy Freeze may **not** be used vs Amazon or Barbarian',
  '• More than 1 hard point in Prayer is banned (for cleanse)',
  '• Defensive GCs are banned',
  '• Hammerdins may use +15% max fire resist vs Sorcs',
  '• Grief is banned on Hammerdin',
  '• Phoenix banned vs Fire Sorcs',
  '• Paladin makes game — exception vs Barb',
  '• Banned auras: activating resist auras (passive pts fine), Meditation, Prayer, Holy Bolt, Redemption',
].join('\n');

const SECTION_AMAZON = [
  `${CLASS_EMOJIS['Amazon']} **AMAZON**`,
  '• Zon can use any armor',
  '• Slow Missile is **banned**',
  '• Max **1 point** in Plague Javelin',
  '• Max **1 point** in Poison Javelin',
  '• Javazon may use Dracul\'s',
  '• Max **one** poison damage small charm',
  '• Strafe is **banned** vs Druid',
  '• Max **10%** life leech on bow side; max **16%** life leech on java side',
  '• Impale vs IAS-based chars is **banned**',
].join('\n');

const SECTION_SORC = [
  `${CLASS_EMOJIS['Sorceress']} **SORCERESS**`,
  '• No max cold/light/fire resist or absorb gear when using Energy Shield *(exception: Nightwing\'s Veil)*',
  '• Energy Shield capped at **90%**',
  '• ES Sorcs: max **1 item** with PDR, max **1 item** with MDR *(MDR from runes not allowed)* — up to 9 MDR / 7 PDR',
  '• ES Sorcs may **not** use more than 25 replenish life',
  '• ES Sorcs may **not** use mana potions',
  '• ES Sorcs may use Oak',
  '• ES Sorcs may **not** use Spirit Sword vs Necromancer',
  '• ES Sorcs may **not** use Blaze vs Wind Druids or Hammerdins',
  '• No stash precasting allowed',
].join('\n');

// ── Embed pages ───────────────────────────────────────────────────────────────

interface RulesPage {
  title: string;
  description: string;
  footer?: string;
}

const PAGES: RulesPage[] = [
  {
    title: 'D2R 1v1 League — Official Rules',
    description: `${ALL_CLASS_EMOJIS}\n\n${SECTION_GENERAL}\n\n${SEP}\n\n${SECTION_MAP}`,
  },
  {
    title: 'Rules (continued)',
    description: SECTION_ITEMS,
  },
  {
    title: 'Rules (continued)',
    description: `${SECTION_DRUID}\n\n${SEP}\n\n${SECTION_NECRO}\n\n${SEP}\n\n${SECTION_BARB}`,
  },
  {
    title: 'Rules (continued)',
    description: SECTION_ASSASSIN,
  },
  {
    title: 'Rules (continued)',
    description: SECTION_PALADIN,
  },
  {
    title: 'Rules (continued)',
    description: `${SECTION_AMAZON}\n\n${SEP}\n\n${SECTION_SORC}`,
    footer: 'Use /matchup <build> <build> for matchup-specific rules.',
  },
];

// ── Command ───────────────────────────────────────────────────────────────────

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('rules')
    .setDescription('Display the D2R 1v1 League general rules'),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();

    const embeds = PAGES.map((page) =>
      new EmbedBuilder()
        .setColor(EMBED_COLORS.rules)
        .setTitle(page.title)
        .setDescription(page.description)
        .setFooter(page.footer ? { text: page.footer } : null)
    );

    await interaction.editReply({ embeds });
  },
};
