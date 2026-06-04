import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  EmbedBuilder,
  Colors,
  TextChannel,
} from 'discord.js';
import type { Command } from '../types/index.js';
import { getBuildChoices, resolveBuild } from '../utils/buildList.js';
import { checkBlacklistViolation } from '../services/blacklist.js';
import { buildErrorEmbed, CAIN_EMOJI } from '../utils/formatters.js';
import { getClassEmoji } from '../utils/classEmojis.js';
import { prisma } from '../db/client.js';
import { getPlayerState } from '../services/queue.js';
import { changePlayerBuildsOnLadder } from '../services/ladder.js';
import { cacheDel } from '../services/cache.js';
import { CacheKeys } from '../types/index.js';
import { updateLeaderboardEmbed } from '../services/leaderboardEmbed.js';
import { CHANNELS } from '../config/channels.js';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('update-builds')
    .setDescription('Change your registered builds mid-season (resets your points to 0)')
    .addStringOption((opt) =>
      opt
        .setName('build_1')
        .setDescription('Your first build (required)')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('build_2')
        .setDescription('Your second build (required)')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('build_3')
        .setDescription('Your third build (optional)')
        .setRequired(false)
        .setAutocomplete(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('build_4')
        .setDescription('Your fourth build (optional)')
        .setRequired(false)
        .setAutocomplete(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('build_5')
        .setDescription('Your fifth build (optional)')
        .setRequired(false)
        .setAutocomplete(true)
    ),

  async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const focused = interaction.options.getFocused(true);
    await interaction.respond(getBuildChoices(focused.value));
  },

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const discordId = interaction.user.id;

    try {
      // Block mid-match changes
      const state = await getPlayerState(discordId);
      if (state === 'in_match') {
        await interaction.editReply({
          embeds: [buildErrorEmbed("You're currently in an active match — finish the match before changing builds.")],
        });
        return;
      }

      // Find active registration
      const season = await prisma.season.findFirst({ where: { active: true } });
      if (!season) {
        await interaction.editReply({ embeds: [buildErrorEmbed('No active season.')] });
        return;
      }

      const player = await prisma.player.findFirst({
        where: { discordId, seasonId: season.id },
      });

      if (!player) {
        await interaction.editReply({
          embeds: [buildErrorEmbed("You aren't registered. Use `/register` to join the league.")],
        });
        return;
      }

      if (player.status === 'REMOVED') {
        await interaction.editReply({
          embeds: [buildErrorEmbed("You've been removed from the ladder. Use `/register` to re-join.")],
        });
        return;
      }

      // Collect and resolve build inputs
      const rawInputs = [
        interaction.options.getString('build_1', true),
        interaction.options.getString('build_2', true),
        interaction.options.getString('build_3', false),
        interaction.options.getString('build_4', false),
        interaction.options.getString('build_5', false),
      ].filter((v): v is string => v !== null && v.trim() !== '');

      const resolved: Array<string | null> = rawInputs.map((r) => resolveBuild(r) ?? null);

      for (let i = 0; i < rawInputs.length; i++) {
        if (resolved[i] === null) {
          await interaction.editReply({
            embeds: [buildErrorEmbed(`Unknown build: **${rawInputs[i]}**. Use the autocomplete list.`)],
          });
          return;
        }
      }

      const builds = resolved as string[];

      // Uniqueness check
      if (new Set(builds).size !== builds.length) {
        await interaction.editReply({
          embeds: [buildErrorEmbed('All builds must be different.')],
        });
        return;
      }

      // Blacklist check
      const violation = await checkBlacklistViolation(builds);
      if (violation) {
        await interaction.editReply({
          embeds: [buildErrorEmbed(
            `Your build combination is not allowed.\n\n**Blocked combo:** ${violation}\n\nYou must include at least one build outside this group.`
          )],
        });
        return;
      }

      // Update Prisma (builds only — points live in Google Sheets, not Postgres)
      await prisma.player.update({
        where: { id: player.id },
        data: {
          build1: builds[0],
          build2: builds[1],
          build3: builds[2] ?? null,
          build4: builds[3] ?? null,
          build5: builds[4] ?? null,
        },
      });

      // Update sheet: builds + zero points
      await changePlayerBuildsOnLadder(discordId, builds);

      // Invalidate ladder cache
      await cacheDel(CacheKeys.ladder());
      updateLeaderboardEmbed(interaction.client).catch((e) =>
        console.error('[/update-builds] Leaderboard update failed:', e)
      );

      const buildList = builds
        .map((b, i) => `${i + 1}. ${getClassEmoji(b)} ${b}`)
        .join('\n');

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Blurple)
            .setTitle(`${CAIN_EMOJI} Builds Updated`)
            .setDescription(
              `Your builds have been updated for **${season.name}**.\n\n` +
              `Your points have been reset to **0** and you've been moved to the bottom of the standings.`
            )
            .addFields({ name: 'New Builds', value: buildList, inline: false })
            .setTimestamp(),
        ],
      });

      // Mod log
      const logChannel = interaction.client.channels.cache.get(CHANNELS.modLogs) as TextChannel | undefined;
      if (logChannel) {
        await logChannel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Blurple)
              .setTitle(`${CAIN_EMOJI} Player Updated Builds`)
              .addFields(
                { name: 'Player', value: `<@${discordId}> (${interaction.user.username})`, inline: true },
                { name: 'Season', value: season.name, inline: true },
                { name: 'New Builds', value: buildList, inline: false },
              )
              .setTimestamp(),
          ],
        });
      }
    } catch (err) {
      console.error('[/update-builds]', err);
      await interaction.editReply({
        embeds: [buildErrorEmbed('Failed to update builds. Try again or contact a mod.')],
      });
    }
  },
};
