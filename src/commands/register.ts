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
import { prisma } from '../db/client.js';
import { CHANNELS } from '../config/channels.js';
import { addPlayerToLadder } from '../services/ladder.js';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('register')
    .setDescription('Register for the D2R 1v1 League with exactly 2 builds')
    .addStringOption((opt) =>
      opt
        .setName('build_1')
        .setDescription('Your first build')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('build_2')
        .setDescription('Your second build')
        .setRequired(true)
        .setAutocomplete(true)
    ),

  async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const focused = interaction.options.getFocused(true);
    await interaction.respond(getBuildChoices(focused.value));
  },

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    // Ephemeral so only the user sees it
    await interaction.deferReply({ ephemeral: true });

    const rawB1 = interaction.options.getString('build_1', true);
    const rawB2 = interaction.options.getString('build_2', true);

    // Resolve builds
    const build1 = resolveBuild(rawB1);
    const build2 = resolveBuild(rawB2);

    if (!build1) {
      await interaction.editReply({ embeds: [buildErrorEmbed(`Unknown build: **${rawB1}**. Use the autocomplete list.`)] });
      return;
    }
    if (!build2) {
      await interaction.editReply({ embeds: [buildErrorEmbed(`Unknown build: **${rawB2}**. Use the autocomplete list.`)] });
      return;
    }
    if (build1 === build2) {
      await interaction.editReply({ embeds: [buildErrorEmbed('Your two builds must be different.')] });
      return;
    }

    const discordId = interaction.user.id;
    const discordUsername = interaction.user.username;

    try {
      // Find the active season
      const season = await prisma.season.findFirst({ where: { active: true } });
      if (!season) {
        await interaction.editReply({
          embeds: [buildErrorEmbed('No active season found. Contact a mod to open the season before registering.')],
        });
        return;
      }

      // Check for existing registration in this season
      const existing = await prisma.player.findFirst({
        where: { discordId, seasonId: season.id },
      });
      if (existing) {
        await interaction.editReply({
          embeds: [
            buildErrorEmbed(
              `You are already registered for **${season.name}** with:\n` +
              `• Build 1: **${existing.build1}**\n` +
              `• Build 2: **${existing.build2}**\n\n` +
              `To change your builds, contact a mod.`
            ),
          ],
        });
        return;
      }

      // Create the player record
      await prisma.player.create({
        data: {
          discordId,
          discordUsername,
          build1,
          build2,
          seasonId: season.id,
        },
      });

      // Add a row to the Ladder sheet (source of truth for standings)
      await addPlayerToLadder(discordId, discordUsername, build1, build2);

      // Confirm to the registering player (ephemeral)
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Green)
            .setTitle('Registration Successful')
            .setDescription(`You've been registered for **${season.name}**!`)
            .addFields(
              { name: 'Build 1', value: build1, inline: true },
              { name: 'Build 2', value: build2, inline: true },
            )
            .setFooter({ text: 'Good luck in the league!' }),
        ],
      });

      // Public announcement in #1v1-sign-up-here
      const signUpChannel = interaction.client.channels.cache.get(CHANNELS.signUpHere) as TextChannel | undefined;
      if (signUpChannel) {
        await signUpChannel.send({ embeds: [buildRegistrationEmbed(discordUsername, discordId, build1, build2)] });
      }

      // Mod log
      const logChannel = interaction.client.channels.cache.get(CHANNELS.modLogs) as TextChannel | undefined;
      if (logChannel) {
        await logChannel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Blurple)
              .setTitle('Player Registered')
              .addFields(
                { name: 'Player', value: `<@${discordId}> (${discordUsername})`, inline: true },
                { name: 'Season', value: season.name, inline: true },
                { name: 'Build 1', value: build1, inline: true },
                { name: 'Build 2', value: build2, inline: true },
              )
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
