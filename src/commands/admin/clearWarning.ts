import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  Colors,
  TextChannel,
} from 'discord.js';
import type { Command } from '../../types/index.js';
import { buildErrorEmbed } from '../../utils/formatters.js';
import { prisma } from '../../db/client.js';
import { CHANNELS } from '../../config/channels.js';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-clear-warning')
    .setDescription("Clear a player's most recent active warning (mod only)")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption((opt) =>
      opt
        .setName('player')
        .setDescription('The player whose warning to clear')
        .setRequired(true)
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const target = interaction.options.getUser('player', true);

    try {
      const season = await prisma.season.findFirst({ where: { active: true } });
      if (!season) {
        await interaction.editReply({ embeds: [buildErrorEmbed('No active season.')] });
        return;
      }

      const player = await prisma.player.findFirst({
        where: { discordId: target.id, seasonId: season.id },
      });

      if (!player) {
        await interaction.editReply({
          embeds: [buildErrorEmbed(`**${target.username}** is not registered in **${season.name}**.`)],
        });
        return;
      }

      if (player.warnings === 0) {
        await interaction.editReply({
          embeds: [buildErrorEmbed(`**${target.username}** has no active warnings to clear.`)],
        });
        return;
      }

      // Find the most recent uncleared warning
      const latestWarning = await prisma.warning.findFirst({
        where: { playerId: player.id, clearedAt: null },
        orderBy: { issuedAt: 'desc' },
      });

      if (!latestWarning) {
        await interaction.editReply({
          embeds: [buildErrorEmbed(`No uncleared warnings found for **${target.username}**.`)],
        });
        return;
      }

      const newWarningCount = Math.max(0, player.warnings - 1);

      await prisma.$transaction([
        prisma.warning.update({
          where: { id: latestWarning.id },
          data: {
            clearedAt: new Date(),
            clearedBy: interaction.user.id,
          },
        }),
        prisma.player.update({
          where: { id: player.id },
          data: { warnings: newWarningCount },
        }),
      ]);

      const embed = new EmbedBuilder()
        .setColor(Colors.Green)
        .setTitle('Warning Cleared')
        .setDescription(`<@${target.id}>'s most recent warning has been cleared.`)
        .addFields(
          { name: 'Remaining Warnings', value: `${newWarningCount}`, inline: true },
          ...(latestWarning.reason ? [{ name: 'Cleared Warning Reason', value: latestWarning.reason, inline: true }] : []),
        )
        .setFooter({ text: `Cleared by ${interaction.user.username}` })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });

      // Mod log
      const logChannel = interaction.client.channels.cache.get(CHANNELS.modLogs) as TextChannel | undefined;
      if (logChannel) {
        await logChannel.send({ embeds: [embed] });
      }
    } catch (err) {
      console.error('[/admin-clear-warning]', err);
      await interaction.editReply({ embeds: [buildErrorEmbed('Command failed. Check server logs.')] });
    }
  },
};
