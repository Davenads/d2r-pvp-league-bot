import { SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction, EmbedBuilder } from 'discord.js';
import type { Command } from '../types/index.js';
import { getBuildChoices, resolveBuild } from '../utils/buildList.js';
import { getDeathmatches, getAllDeathmatches } from '../services/matchup.js';
import { buildErrorEmbed, buildUnavailableEmbed, EMBED_COLORS } from '../utils/formatters.js';
import { getClassEmoji, CAIN_EMOJI } from '../utils/classEmojis.js';

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
                  return `${i + 1}. ${altEmoji ? altEmoji + ' ' : ''}${alt}`;
                }).join('\n')
              : '*No deathmatch opponents listed for this build.*'
          )
          .setFooter({ text: 'Contact a mod to trigger a deathmatch.' });

        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        console.error('[/deathmatch]', err);
        await interaction.editReply({ embeds: [buildUnavailableEmbed()] });
      }
      return;
    }

    // ── All builds ────────────────────────────────────────────────────────────
    try {
      const allResults = await getAllDeathmatches();

      const lines = allResults
        .filter((r) => r.alternatives.length > 0)
        .map((r) => {
          const emoji = getClassEmoji(r.build);
          const buildLabel = emoji ? `${emoji} **${r.build}**` : `**${r.build}**`;
          const alts = r.alternatives.map((alt) => {
            const altEmoji = getClassEmoji(alt);
            return altEmoji ? `${altEmoji} ${alt}` : alt;
          });
          return `${buildLabel} — ${alts.join(', ')}`;
        });

      const embed = new EmbedBuilder()
        .setColor(EMBED_COLORS.rules)
        .setTitle(`${CAIN_EMOJI} All Deathmatch Matchups`)
        .setDescription(lines.length ? lines.join('\n') : '*No deathmatch matchups found.*')
        .setFooter({ text: 'Use /deathmatch [build] to filter to a specific build.' });

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('[/deathmatch]', err);
      await interaction.editReply({ embeds: [buildUnavailableEmbed()] });
    }
  },
};
