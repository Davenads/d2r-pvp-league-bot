import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
  TextChannel,
  ThreadChannel,
} from 'discord.js';
import type { Command } from '../../types/index.js';
import { buildErrorEmbed, CAIN_EMOJI } from '../../utils/formatters.js';
import { prisma } from '../../db/client.js';
import { CHANNELS } from '../../config/channels.js';
import { updatePlayerLadderStatus } from '../../services/ladder.js';
import { leaveQueue, removeActiveMatch, resolvePlayerStateAfterMatch } from '../../services/queue.js';
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

      const player = await prisma.player.findUnique({
        where: { discordId: target.id },
      });

      if (!player) {
        await interaction.editReply({
          embeds: [buildErrorEmbed(`**${target.username}** is not registered in any season.`)],
        });
        return;
      }

      if (player.status === 'REMOVED') {
        await interaction.editReply({
          embeds: [buildErrorEmbed(`**${target.username}** has already been removed.`)],
        });
        return;
      }

      // Void all PENDING matches and clean up opponent Redis state
      const pendingMatches = await prisma.match.findMany({
        where: {
          status: 'PENDING',
          OR: [
            { player1: { discordId: target.id } },
            { player2: { discordId: target.id } },
          ],
        },
        include: { player1: true, player2: true },
      });

      for (const match of pendingMatches) {
        await prisma.match.update({
          where: { id: match.id },
          data: { status: 'VOIDED' },
        });

        const opponentDiscordId =
          match.player1.discordId === target.id
            ? match.player2.discordId
            : match.player1.discordId;

        await removeActiveMatch(match.id, target.id, opponentDiscordId);
        await resolvePlayerStateAfterMatch(opponentDiscordId);

        // Notify the match thread
        if (match.threadId) {
          try {
            const thread = interaction.client.channels.cache.get(match.threadId) as ThreadChannel | undefined;
            if (thread?.isThread()) {
              await thread.send({
                content: `<@${opponentDiscordId}>`,
                embeds: [
                  new EmbedBuilder()
                    .setColor(Colors.Red)
                    .setTitle(`${CAIN_EMOJI} Match Voided`)
                    .setDescription(`<@${target.id}> has been removed from the ladder by a moderator. Match #${match.id} has been voided.`)
                    .setTimestamp(),
                ],
              });
              await thread.setArchived(true, 'Player removed from ladder').catch(() => undefined);
            }
          } catch {
            // Non-fatal
          }
        }

        // Notify #1v1-match-results
        const resultsChannel = interaction.client.channels.cache.get(CHANNELS.matchResults) as TextChannel | undefined;
        if (resultsChannel) {
          await resultsChannel.send({
            embeds: [
              new EmbedBuilder()
                .setColor(Colors.Red)
                .setTitle(`${CAIN_EMOJI} Match Voided — Player Removed`)
                .addFields(
                  { name: 'Match #', value: String(match.id), inline: true },
                  { name: 'Removed', value: `<@${target.id}>`, inline: true },
                  { name: 'Opponent', value: `<@${opponentDiscordId}>`, inline: true },
                )
                .setTimestamp(),
            ],
          });
        }
      }

      // Clean up removed player's own Redis state
      await resolvePlayerStateAfterMatch(target.id);
      await leaveQueue(target.id);

      await prisma.player.update({
        where: { id: player.id },
        data: { status: 'REMOVED', removedAt: new Date() },
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
                { name: 'Matches Voided', value: String(pendingMatches.length), inline: true },
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
