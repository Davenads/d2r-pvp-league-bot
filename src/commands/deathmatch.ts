import { SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction, EmbedBuilder } from 'discord.js';
import type { Command } from '../types/index.js';
import { getBuildChoices, resolveBuild } from '../utils/buildList.js';
import { getDeathmatches } from '../services/matchup.js';
import { getDeathmatches as getAllDeathmatches } from '../services/content.js';
import { buildErrorEmbed, buildUnavailableEmbed, EMBED_COLORS } from '../utils/formatters.js';
import { getClassEmoji, CAIN_EMOJI } from '../utils/classEmojis.js';

function buildDeathmatchInfoEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(EMBED_COLORS.info)
    .setTitle('What is a Deathmatch?')
    .setDescription(
      [
        'When two players are matched and one build lists the other as a deathmatch opponent, the match format is **asymmetric**.',
        '',
        '**The listed build (column A)** plays **FT2** (First to 2 wins)',
        '**The opponent build** plays **FT4** (First to 4 wins)',
        '**Points:** Same as a standard match — +1 win / 0 loss',
        '**Trigger:** Automatic at queue time — no action needed from players',
        '',
        'Only one build needs to list the other. The relationship is **not** required to be mutual.',
        'Deathmatch pairings are defined by the mods in the league sheet.',
      ].join('\n')
    );
}

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('deathmatch')
    .setDescription('Show deathmatch opponents — omit build to see all')
    .addStringOption((opt) =>
      opt
        .setName('build')
        .setDescription('Filter to a specific build (optional)')
        .setRequired(false)
        .setAutocomplete(true)
    ),

  async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const focused = interaction.options.getFocused();
    await interaction.respond(getBuildChoices(focused));
  },

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const raw = interaction.options.getString('build');

    // ── Single build ──────────────────────────────────────────────────────────
    if (raw) {
      const build = resolveBuild(raw);
      if (!build) {
        await interaction.editReply({ embeds: [buildErrorEmbed(`Unknown build: **${raw}**. Use the autocomplete list.`)] });
        return;
      }

      try {
        const result = await getDeathmatches(build);

        if (!result) {
          await interaction.editReply({ embeds: [buildUnavailableEmbed()] });
          return;
        }

        const emoji = getClassEmoji(build);
        const buildLabel = emoji ? `${emoji} ${build}` : build;
        const embed = new EmbedBuilder()
          .setColor(EMBED_COLORS.rules)
          .setTitle(`${CAIN_EMOJI} Deathmatch Opponents — ${buildLabel}`)
          .setDescription(
            result.alternatives.length
              ? result.alternatives.map((alt, i) => {
                  const altEmoji = getClassEmoji(alt);
                  const sepIdx = alt.indexOf(' - ');
                  const shortName = sepIdx !== -1 ? alt.slice(sepIdx + 3) : alt;
                  return `${i + 1}. ${altEmoji ? altEmoji + ' ' : ''}${shortName}`;
                }).join('\n')
              : '*No deathmatch opponents listed for this build.*'
          )
          .setFooter({ text: `${build} plays FT2 · Opponents play FT4` });

        await interaction.editReply({ embeds: [embed, buildDeathmatchInfoEmbed()] });
      } catch (err) {
        console.error('[/deathmatch]', err);
        await interaction.editReply({ embeds: [buildUnavailableEmbed()] });
      }
      return;
    }

    // ── All builds ────────────────────────────────────────────────────────────
    try {
      const dmMap = await getAllDeathmatches();

      // Filter out the sheet header row ("Build" key) and entries with no opponents
      const lines = [...dmMap.entries()]
        .filter(([build, alts]) => alts.length > 0 && resolveBuild(build) != null)
        .map(([build, alts]) => {
          const emoji = getClassEmoji(build);
          const buildLabel = emoji ? `${emoji} **${build}**` : `**${build}**`;
          const altLabels = alts.map((alt) => {
            const altEmoji = getClassEmoji(alt);
            const sepIdx = alt.indexOf(' - ');
            const shortName = sepIdx !== -1 ? alt.slice(sepIdx + 3) : alt;
            return altEmoji ? `${altEmoji} ${shortName}` : shortName;
          });
          return `${buildLabel} — ${altLabels.join(', ')}`;
        });

      // Paginate across embeds to stay under Discord's 4096-char description limit
      const MAX_DESC = 4000;
      const pages: string[][] = [[]];
      let currentLen = 0;
      for (const line of lines) {
        const lineLen = line.length + 1; // +1 for newline separator
        if (currentLen + lineLen > MAX_DESC && pages[pages.length - 1].length > 0) {
          pages.push([]);
          currentLen = 0;
        }
        pages[pages.length - 1].push(line);
        currentLen += lineLen;
      }

      const LEGEND = '-# **Bold** = FT2 · Regular = FT4\n';
      const embeds = pages.map((pageLines, i) =>
        new EmbedBuilder()
          .setColor(EMBED_COLORS.rules)
          .setTitle(i === 0 ? `${CAIN_EMOJI} All Deathmatch Matchups` : `${CAIN_EMOJI} All Deathmatch Matchups (continued)`)
          .setDescription(
            (i === 0 ? LEGEND + '\n' : '') +
            (pageLines.length ? pageLines.join('\n') : '*No deathmatch matchups found.*')
          )
          .setFooter(i === pages.length - 1 ? { text: 'Use /deathmatch [build] to filter to a specific build.' } : null)
      );

      await interaction.editReply({ embeds: [embeds[0]] });
      for (let i = 1; i < embeds.length; i++) {
        await interaction.followUp({ ephemeral: true, embeds: [embeds[i]] });
      }
      await interaction.followUp({ ephemeral: true, embeds: [buildDeathmatchInfoEmbed()] });
    } catch (err) {
      console.error('[/deathmatch]', err);
      await interaction.editReply({ embeds: [buildUnavailableEmbed()] });
    }
  },
};
