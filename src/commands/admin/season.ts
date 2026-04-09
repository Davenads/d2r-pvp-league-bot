import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  Colors,
} from 'discord.js';
import type { Command } from '../../types/index.js';
import { prisma } from '../../db/client.js';
import { EMBED_COLORS } from '../../utils/formatters.js';
import { assertModRole } from '../../utils/modGuard.js';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-season')
    .setDescription('Manage league seasons (mod only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('open')
        .setDescription('Open a new season (closes any currently active season)')
        .addStringOption((opt) =>
          opt
            .setName('name')
            .setDescription('Season name, e.g. "Season 1"')
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('close')
        .setDescription('Close the currently active season')
    )
    .addSubcommand((sub) =>
      sub
        .setName('status')
        .setDescription('Show current season info')
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    if (!await assertModRole(interaction)) return;

    const sub = interaction.options.getSubcommand(true);

    try {
      if (sub === 'open') {
        const name = interaction.options.getString('name', true).trim();

        // Close any currently active season first
        const existing = await prisma.season.findFirst({ where: { active: true } });
        if (existing) {
          await prisma.season.update({
            where: { id: existing.id },
            data: { active: false, endedAt: new Date() },
          });
        }

        // Create the new season
        const season = await prisma.season.create({
          data: { name, active: true },
        });

        const embed = new EmbedBuilder()
          .setColor(Colors.Green)
          .setTitle('Season Opened')
          .setDescription(`**${season.name}** is now active. Players can register.`)
          .addFields(
            { name: 'Season ID', value: String(season.id), inline: true },
            { name: 'Started', value: `<t:${Math.floor(season.startedAt.getTime() / 1000)}:F>`, inline: true },
          );

        if (existing) {
          embed.addFields({ name: 'Previous Season Closed', value: existing.name, inline: false });
        }

        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (sub === 'close') {
        const season = await prisma.season.findFirst({ where: { active: true } });
        if (!season) {
          await interaction.editReply({
            embeds: [new EmbedBuilder()
              .setColor(EMBED_COLORS.warning)
              .setTitle('No Active Season')
              .setDescription('There is no active season to close.')],
          });
          return;
        }

        await prisma.season.update({
          where: { id: season.id },
          data: { active: false, endedAt: new Date() },
        });

        const playerCount = await prisma.player.count({ where: { seasonId: season.id } });
        const matchCount = await prisma.match.count({ where: { seasonId: season.id } });

        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Red)
              .setTitle('Season Closed')
              .setDescription(`**${season.name}** has been closed.`)
              .addFields(
                { name: 'Players', value: String(playerCount), inline: true },
                { name: 'Matches', value: String(matchCount), inline: true },
              )
              .setTimestamp(),
          ],
        });
        return;
      }

      if (sub === 'status') {
        const season = await prisma.season.findFirst({ where: { active: true } });

        if (!season) {
          // Check if there are any past seasons
          const latest = await prisma.season.findFirst({ orderBy: { id: 'desc' } });
          if (!latest) {
            await interaction.editReply({
              embeds: [new EmbedBuilder()
                .setColor(EMBED_COLORS.warning)
                .setTitle('No Seasons Found')
                .setDescription('No seasons have been created yet. Use `/admin-season open` to start one.')],
            });
            return;
          }

          await interaction.editReply({
            embeds: [new EmbedBuilder()
              .setColor(EMBED_COLORS.warning)
              .setTitle('No Active Season')
              .setDescription(`The most recent season was **${latest.name}**, which has ended.`)
              .addFields(
                { name: 'Ended', value: latest.endedAt ? `<t:${Math.floor(latest.endedAt.getTime() / 1000)}:F>` : 'Unknown', inline: true },
              )],
          });
          return;
        }

        const playerCount = await prisma.player.count({ where: { seasonId: season.id } });
        const matchCount = await prisma.match.count({
          where: { seasonId: season.id, status: 'CONFIRMED' },
        });

        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Green)
              .setTitle('Active Season')
              .setDescription(`**${season.name}** is currently running.`)
              .addFields(
                { name: 'Season ID', value: String(season.id), inline: true },
                { name: 'Started', value: `<t:${Math.floor(season.startedAt.getTime() / 1000)}:F>`, inline: true },
                { name: 'Registered Players', value: String(playerCount), inline: true },
                { name: 'Confirmed Matches', value: String(matchCount), inline: true },
              )
              .setTimestamp(),
          ],
        });
      }
    } catch (err) {
      console.error('[/admin-season]', err);
      await interaction.editReply({
        embeds: [new EmbedBuilder()
          .setColor(EMBED_COLORS.error)
          .setTitle('Error')
          .setDescription('Command failed. Check server logs.')],
      });
    }
  },
};
