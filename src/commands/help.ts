import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import type { Command } from '../types/index.js';
import { EMBED_COLORS, CAIN_EMOJI } from '../utils/formatters.js';

const COMMANDS = [
  {
    category: 'League Info',
    entries: [
      { name: '/rules', description: 'Display the D2R 1v1 League general rules' },
      { name: '/test-rules', description: 'Display the test ruleset' },
      { name: '/faq', description: 'Browse frequently asked questions' },
      { name: '/matchup <your_build> <opponent_build>', description: 'Look up rules for a specific build vs build matchup' },
      { name: '/banned-matchups [build]', description: 'List all banned matchups, optionally filtered by build' },
      { name: '/deathmatch <build>', description: 'Show deathmatch alternative opponents for a build' },
    ],
  },
  {
    category: 'Ladder & Players',
    entries: [
      { name: '/ladder [page]', description: 'Show current league standings' },
      { name: '/player <name>', description: "Look up a player's stats, builds, and record" },
    ],
  },
  {
    category: 'Registration & Matches',
    entries: [
      { name: '/register <ign> <build1> <build2> [build3-5]', description: 'Register for the league (2 builds required, up to 5)' },
      { name: '/queue', description: 'Enter the match queue' },
      { name: '/report-win <opponent>', description: 'Report a match result (winner initiates)' },
      { name: '/request-mirror <opponent> <build>', description: 'Request a mirror match (both players must consent)' },
    ],
  },
];

const MAX_FIELD_VALUE = 1024;

function buildHelpEmbeds(): EmbedBuilder[] {
  const embeds: EmbedBuilder[] = [];

  let currentEmbed = new EmbedBuilder()
    .setColor(EMBED_COLORS.rules)
    .setTitle(`${CAIN_EMOJI} D2R 1v1 League — Command Reference`)
    .setDescription('All available commands for league players.');

  let currentCharCount = 0;

  for (const category of COMMANDS) {
    const fieldValue = category.entries
      .map((e) => `\`${e.name}\`\n${e.description}`)
      .join('\n\n');

    if (fieldValue.length > MAX_FIELD_VALUE) {
      // Split oversized category into multiple fields
      let chunk = '';
      let part = 1;
      for (const entry of category.entries) {
        const line = `\`${entry.name}\`\n${entry.description}\n\n`;
        if (chunk.length + line.length > MAX_FIELD_VALUE) {
          currentEmbed.addFields({ name: `${category.category} (${part++})`, value: chunk.trimEnd() });
          currentCharCount += chunk.length;
          chunk = '';
        }
        chunk += line;
      }
      if (chunk.trim()) {
        currentEmbed.addFields({ name: `${category.category} (${part})`, value: chunk.trimEnd() });
        currentCharCount += chunk.length;
      }
    } else {
      // If adding this field would push total embed content over Discord's 6000-char limit,
      // start a fresh embed (continuation header, no repeated title).
      if (currentCharCount + fieldValue.length + category.category.length > 5500) {
        embeds.push(currentEmbed);
        currentEmbed = new EmbedBuilder().setColor(EMBED_COLORS.rules);
        currentCharCount = 0;
      }
      currentEmbed.addFields({ name: category.category, value: fieldValue });
      currentCharCount += fieldValue.length + category.category.length;
    }
  }

  embeds.push(currentEmbed);
  return embeds;
}

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show all available player commands'),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const embeds = buildHelpEmbeds();

    // Discord allows max 10 embeds per message
    for (let i = 0; i < embeds.length; i += 10) {
      const batch = embeds.slice(i, i + 10);
      if (i === 0) {
        await interaction.editReply({ embeds: batch });
      } else {
        await interaction.followUp({ embeds: batch, ephemeral: true });
      }
    }
  },
};
