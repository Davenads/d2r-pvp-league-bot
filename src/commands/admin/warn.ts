import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
  TextChannel,
} from 'discord.js';
import type { Command } from '../../types/index.js';
import { buildErrorEmbed, CAIN_EMOJI } from '../../utils/formatters.js';
import { prisma } from '../../db/client.js';
import { CHANNELS } from '../../config/channels.js';
import { config } from '../../config.js';
import { assertModRole } from '../../utils/modGuard.js';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-warn')
    .setDescription('Issue a warning to a player (mod only)')
    .addUserOption((opt) =>
      opt
        .setName('player')
        .setDescription('The player to warn')
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('reason')
        .setDescription('Reason for the warning (optional)')
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    if (!await assertModRole(interaction)) return;

    const target = interaction.options.getUser('player', true);
    const reason = interaction.options.getString('reason') ?? null;
    const threshold = config.league.warningThreshold;

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

      if (player.status === 'REMOVED') {
        await interaction.editReply({
          embeds: [buildErrorEmbed(`**${target.username}** has already been removed from the ladder.`)],
        });
        return;
      }

      // Create warning record and increment count in one transaction
      const newWarningCount = player.warnings + 1;
      const autoRemove = newWarningCount >= threshold;

      await prisma.$transaction([
        prisma.warning.create({
          data: {
            playerId: player.id,
            reason,
            issuedBy: interaction.user.id,
          },
        }),
        prisma.player.update({
          where: { id: player.id },
          data: {
            warnings: newWarningCount,
            ...(autoRemove ? { status: 'REMOVED' } : {}),
          },
        }),
      ]);

      const embed = new EmbedBuilder()
        .setColor(autoRemove ? Colors.Red : Colors.Yellow)
        .setTitle(autoRemove ? `${CAIN_EMOJI} Warning Issued — Player Auto-Removed` : `${CAIN_EMOJI} Warning Issued`)
        .setDescription(
          autoRemove
            ? `<@${target.id}> has received warning **${newWarningCount}/${threshold}** and has been **automatically removed** from the ladder.`
            : `<@${target.id}> has received warning **${newWarningCount}/${threshold}**.`
        )
        .addFields(
          ...(reason ? [{ name: 'Reason', value: reason, inline: false }] : []),
        )
        .setFooter({ text: `Issued by ${interaction.user.username}` })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });

      // Mod log
      const logChannel = interaction.client.channels.cache.get(CHANNELS.modLogs) as TextChannel | undefined;
      if (logChannel) {
        await logChannel.send({ embeds: [embed] });
      }
    } catch (err) {
      console.error('[/admin-warn]', err);
      await interaction.editReply({ embeds: [buildErrorEmbed('Command failed. Check server logs.')] });
    }
  },
};
