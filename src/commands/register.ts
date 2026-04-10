import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  TextChannel,
  EmbedBuilder,
  Colors,
} from 'discord.js';
import type { Command } from '../types/index.js';
import { getBuildChoices, resolveBuild } from '../utils/buildList.js';
import { buildErrorEmbed, buildRegistrationEmbed } from '../utils/formatters.js';
import { getClassEmoji } from '../utils/classEmojis.js';
import { prisma } from '../db/client.js';
import { CHANNELS } from '../config/channels.js';
import { addPlayerToLadder, reactivatePlayerOnLadder } from '../services/ladder.js';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('register')
    .setDescription('Register for the D2R 1v1 League (2 builds required, up to 5)')
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

    // Collect raw inputs (build_1 and build_2 are required; 3–5 are optional)
    const rawInputs = [
      interaction.options.getString('build_1', true),
      interaction.options.getString('build_2', true),
      interaction.options.getString('build_3', false),
      interaction.options.getString('build_4', false),
      interaction.options.getString('build_5', false),
    ].filter((v): v is string => v !== null && v.trim() !== '');

    // Resolve each raw input to a canonical build name
    const resolved: Array<string | null> = rawInputs.map((r) => resolveBuild(r) ?? null);

    // Check for unresolved builds
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
        embeds: [buildErrorEmbed('All registered builds must be different.')],
      });
      return;
    }

    const discordId = interaction.user.id;
    const discordUsername = interaction.user.username;

    try {
      const season = await prisma.season.findFirst({ where: { active: true } });
      if (!season) {
        await interaction.editReply({
          embeds: [buildErrorEmbed('No active season found. Contact a mod to open the season before registering.')],
        });
        return;
      }

      const existing = await prisma.player.findFirst({
        where: { discordId, seasonId: season.id },
      });

      if (existing && existing.status !== 'REMOVED') {
        const existingBuilds = [existing.build1, existing.build2, existing.build3, existing.build4, existing.build5]
          .filter((b): b is string => !!b);
        const buildList = existingBuilds.map((b, i) => `• Build ${i + 1}: **${b}**`).join('\n');
        await interaction.editReply({
          embeds: [
            buildErrorEmbed(
              `You are already registered for **${season.name}** with:\n${buildList}\n\nTo change your builds, contact a mod.`
            ),
          ],
        });
        return;
      }

      if (existing && existing.status === 'REMOVED') {
        await prisma.player.update({
          where: { id: existing.id },
          data: {
            discordUsername,
            build1: builds[0],
            build2: builds[1],
            build3: builds[2] ?? null,
            build4: builds[3] ?? null,
            build5: builds[4] ?? null,
            status: 'ACTIVE',
            warnings: 0,
            registeredAt: new Date(),
            lastMatchAt: null,
          },
        });
        await reactivatePlayerOnLadder(discordId, discordUsername, builds);
      } else {
        await prisma.player.create({
          data: {
            discordId,
            discordUsername,
            build1: builds[0],
            build2: builds[1],
            build3: builds[2] ?? null,
            build4: builds[3] ?? null,
            build5: builds[4] ?? null,
            seasonId: season.id,
          },
        });
        await addPlayerToLadder(discordId, discordUsername, builds);
      }

      // Confirm to the registering player (ephemeral)
      const buildFields = builds.map((b, i) => {
        const emoji = getClassEmoji(b);
        return { name: `Build ${i + 1}`, value: emoji ? `${emoji} ${b}` : b, inline: true };
      });
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Green)
            .setTitle('Registration Successful')
            .setDescription(`You've been registered for **${season.name}**!`)
            .addFields(...buildFields)
            .setFooter({ text: 'Good luck in the league!' }),
        ],
      });

      // Public announcement in #1v1-sign-up-here
      const signUpChannel = interaction.client.channels.cache.get(CHANNELS.signUpHere) as TextChannel | undefined;
      if (signUpChannel) {
        await signUpChannel.send({ embeds: [buildRegistrationEmbed(discordUsername, discordId, builds)] });
      }

      // Mod log
      const logChannel = interaction.client.channels.cache.get(CHANNELS.modLogs) as TextChannel | undefined;
      if (logChannel) {
        const logFields = [
          { name: 'Player', value: `<@${discordId}> (${discordUsername})`, inline: true },
          { name: 'Season', value: season.name, inline: true },
          ...builds.map((b, i) => {
            const emoji = getClassEmoji(b);
            return { name: `Build ${i + 1}`, value: emoji ? `${emoji} ${b}` : b, inline: true };
          }),
        ];
        await logChannel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Blurple)
              .setTitle('Player Registered')
              .addFields(...logFields)
              .setTimestamp(),
          ],
        });
      }
    } catch (err) {
      console.error('[/register]', err);
      await interaction.editReply({
        embeds: [buildErrorEmbed('Registration failed due to a server error. Please try again or contact a mod.')],
      });
    }
  },
};
