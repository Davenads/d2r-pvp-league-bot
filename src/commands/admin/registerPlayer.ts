import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  Colors,
  TextChannel,
} from 'discord.js';
import type { Command } from '../../types/index.js';
import { getBuildChoices, resolveBuild } from '../../utils/buildList.js';
import { buildErrorEmbed, buildRegistrationEmbed } from '../../utils/formatters.js';
import { prisma } from '../../db/client.js';
import { CHANNELS } from '../../config/channels.js';
import { addPlayerToLadder } from '../../services/ladder.js';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-register')
    .setDescription('Register a player on their behalf (mod only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption((opt) =>
      opt
        .setName('player')
        .setDescription('The Discord user to register')
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('build_1')
        .setDescription('First build')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('build_2')
        .setDescription('Second build')
        .setRequired(true)
        .setAutocomplete(true)
    ),

  async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const focused = interaction.options.getFocused(true);
    await interaction.respond(getBuildChoices(focused.value));
  },

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const target = interaction.options.getUser('player', true);
    const rawB1 = interaction.options.getString('build_1', true);
    const rawB2 = interaction.options.getString('build_2', true);

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
      await interaction.editReply({ embeds: [buildErrorEmbed('The two builds must be different.')] });
      return;
    }

    try {
      const season = await prisma.season.findFirst({ where: { active: true } });
      if (!season) {
        await interaction.editReply({ embeds: [buildErrorEmbed('No active season. Open one with `/admin-season open` first.')] });
        return;
      }

      const existing = await prisma.player.findFirst({
        where: { discordId: target.id, seasonId: season.id },
      });
      if (existing) {
        await interaction.editReply({
          embeds: [buildErrorEmbed(
            `**${target.username}** is already registered for **${season.name}**:\n` +
            `• Build 1: **${existing.build1}**\n` +
            `• Build 2: **${existing.build2}**`
          )],
        });
        return;
      }

      await prisma.player.create({
        data: {
          discordId: target.id,
          discordUsername: target.username,
          build1,
          build2,
          seasonId: season.id,
        },
      });

      // Add a row to the Ladder sheet (source of truth for standings)
      await addPlayerToLadder(target.id, target.username, build1, build2);

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Green)
            .setTitle('Player Registered')
            .setDescription(`<@${target.id}> has been registered for **${season.name}**.`)
            .addFields(
              { name: 'Build 1', value: build1, inline: true },
              { name: 'Build 2', value: build2, inline: true },
            )
            .setFooter({ text: `Registered by ${interaction.user.username}` })
            .setTimestamp(),
        ],
      });

      // Public announcement
      const signUpChannel = interaction.client.channels.cache.get(CHANNELS.signUpHere) as TextChannel | undefined;
      if (signUpChannel) {
        await signUpChannel.send({ embeds: [buildRegistrationEmbed(target.username, target.id, build1, build2)] });
      }

      // Mod log
      const logChannel = interaction.client.channels.cache.get(CHANNELS.modLogs) as TextChannel | undefined;
      if (logChannel) {
        await logChannel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Blurple)
              .setTitle('Admin: Player Registered')
              .addFields(
                { name: 'Player', value: `<@${target.id}> (${target.username})`, inline: true },
                { name: 'Registered By', value: `<@${interaction.user.id}>`, inline: true },
                { name: 'Season', value: season.name, inline: true },
                { name: 'Build 1', value: build1, inline: true },
                { name: 'Build 2', value: build2, inline: true },
              )
              .setTimestamp(),
          ],
        });
      }
    } catch (err) {
      console.error('[/admin-register]', err);
      await interaction.editReply({ embeds: [buildErrorEmbed('Registration failed. Check server logs.')] });
    }
  },
};
