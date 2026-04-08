import { SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction, EmbedBuilder } from 'discord.js';
import type { Command } from '../types/index.js';
import { getBuildChoices, resolveBuild } from '../utils/buildList.js';
import { getDeathmatches } from '../services/matchup.js';
import { buildErrorEmbed, buildUnavailableEmbed, EMBED_COLORS } from '../utils/formatters.js';
import { getClassEmoji } from '../utils/classEmojis.js';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('deathmatch')
    .setDescription('Show the deathmatch alternative opponents for a given build')
    .addStringOption((opt) =>
      opt
        .setName('build')
        .setDescription('The build to look up')
        .setRequired(true)
        .setAutocomplete(true)
    ),

  async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const focused = interaction.options.getFocused();
    await interaction.respond(getBuildChoices(focused));
  },

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();

    const raw = interaction.options.getString('build', true);
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
        .setTitle(`Deathmatch Alternatives — ${buildLabel}`)
        .setDescription(
          result.alternatives.length
            ? result.alternatives.map((alt, i) => {
                const altEmoji = getClassEmoji(alt);
                return `${i + 1}. ${altEmoji ? altEmoji + ' ' : ''}${alt}`;
              }).join('\n')
            : '*No deathmatch alternatives listed for this build.*'
        )
        .setFooter({ text: 'Contact a mod to trigger a deathmatch.' });

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('[/deathmatch]', err);
      await interaction.editReply({ embeds: [buildUnavailableEmbed()] });
    }
  },
};
