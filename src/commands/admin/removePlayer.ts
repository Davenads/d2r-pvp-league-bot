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
import { updatePlayerLadderStatus } from '../../services/ladder.js';
import { assertModRole } from '../../utils/modGuard.js';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-remove-player')
    .setDescription('Remove a player from the active season (mod only)')
    .addUserOption((opt) =>
      opt
        .setName('player')
        .setDescription('The Discord user to remove')
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('reason')
        .setDescription('Reason for removal (optional)')
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    if (!await assertModRole(interaction)) return;

    const target = interaction.options.getUser('player', true);
    const reason = interaction.options.getString('reason') ?? 'No reason provided';

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
          embeds: [buildErrorEmbed(`**${target.username}** has already been removed from **${season.name}**.`)],
        });
        return;
      }

      await prisma.player.update({
        where: { id: player.id },
        data: { status: 'REMOVED' },
      });

      // Mirror status to the Ladder sheet
      await updatePlayerLadderStatus(target.id, 'Removed');

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Red)
            .setTitle(`${CAIN_EMOJI} Player Removed`)
            .setDescription(`<@${target.id}> has been removed from **${season.name}**.`)
            .addFields({ name: 'Reason', value: reason })
            .setFooter({ text: `Removed by ${interaction.user.username}` })
            .setTimestamp(),
        ],
      });

      // Mod log
      const logChannel = interaction.client.channels.cache.get(CHANNELS.modLogs) as TextChannel | undefined;
      if (logChannel) {
        await logChannel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Red)
              .setTitle(`${CAIN_EMOJI} Admin: Player Removed`)
              .addFields(
                { name: 'Player', value: `<@${target.id}> (${target.username})`, inline: true },
                { name: 'Removed By', value: `<@${interaction.user.id}>`, inline: true },
                { name: 'Season', value: season.name, inline: true },
                { name: 'Reason', value: reason, inline: false },
              )
              .setTimestamp(),
          ],
        });
      }
    } catch (err) {
      console.error('[/admin-remove-player]', err);
      await interaction.editReply({ embeds: [buildErrorEmbed('Command failed. Check server logs.')] });
    }
  },
};
