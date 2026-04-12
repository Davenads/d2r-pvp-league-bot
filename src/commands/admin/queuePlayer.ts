/**
 * /admin-queue-player
 *
 * Mod-only command to place a registered player into the match queue on their behalf.
 * Useful for QA testing and for placing players who cannot run /queue themselves.
 * Triggers normal FIFO matching — if another player is already waiting, a match fires immediately.
 */

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
  TextChannel,
  ChannelType,
  PermissionFlagsBits,
} from 'discord.js';
import type { ThreadChannel } from 'discord.js';
import type { Command } from '../../types/index.js';
import { buildErrorEmbed, EMBED_COLORS } from '../../utils/formatters.js';
import { prisma } from '../../db/client.js';
import { joinQueue, getPlayerState, setMatchThreadId } from '../../services/queue.js';
import { postAllBannedEmbed, postMatchAnnouncementEmbed } from '../../utils/matchupUI.js';
import { CHANNELS } from '../../config/channels.js';
import { assertModRole } from '../../utils/modGuard.js';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-queue-player')
    .setDescription('Place a registered player into the match queue on their behalf (mod only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption((opt) =>
      opt
        .setName('player')
        .setDescription('The player to queue')
        .setRequired(true)
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    if (!assertModRole(interaction)) {
      await interaction.editReply({ embeds: [buildErrorEmbed('You do not have permission to use this command.')] });
      return;
    }

    const targetUser = interaction.options.getUser('player', true);

    try {
      // Verify active season
      const season = await prisma.season.findFirst({ where: { active: true } });
      if (!season) {
        await interaction.editReply({ embeds: [buildErrorEmbed('No active season.')] });
        return;
      }

      // Verify the target is a registered player
      const player = await prisma.player.findFirst({
        where: { discordId: targetUser.id, seasonId: season.id },
      });

      if (!player) {
        await interaction.editReply({
          embeds: [buildErrorEmbed(`<@${targetUser.id}> is not registered for this season.`)],
        });
        return;
      }

      if (player.status === 'REMOVED') {
        await interaction.editReply({
          embeds: [buildErrorEmbed(`<@${targetUser.id}> has been removed from the league.`)],
        });
        return;
      }

      // Check current state
      const currentState = await getPlayerState(targetUser.id);

      if (currentState === 'queued') {
        await interaction.editReply({
          embeds: [buildErrorEmbed(`<@${targetUser.id}> is already in the queue.`)],
        });
        return;
      }

      if (currentState === 'in_match') {
        await interaction.editReply({
          embeds: [buildErrorEmbed(`<@${targetUser.id}> is currently in an active match.`)],
        });
        return;
      }

      // Join the queue via normal FIFO logic
      const outcome = await joinQueue(targetUser.id);

      if (!outcome.matched) {
        // No opponent waiting — player is now queued
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(EMBED_COLORS.info)
              .setTitle('Player Queued')
              .setDescription(`<@${targetUser.id}> has been added to the queue at position #${outcome.position}.`)
              .setFooter({ text: 'They will be matched when another player joins.' }),
          ],
        });

        const modQueueChannel = interaction.client.channels.cache.get(CHANNELS.modQueue) as TextChannel | undefined;
        if (modQueueChannel) {
          await modQueueChannel.send({
            embeds: [
              new EmbedBuilder()
                .setColor(EMBED_COLORS.info)
                .setDescription(`<@${targetUser.id}> added to queue by mod <@${interaction.user.id}> — position #${outcome.position}`)
                .setTimestamp(),
            ],
          });
        }
        return;
      }

      // ── Match found immediately ───────────────────────────────────────────────

      const { opponentDiscordId, matchId, selectedMatchup, matchType, allBanned } = outcome;

      const opponentUser = await interaction.client.users.fetch(opponentDiscordId).catch(() => null);
      const threadName = `Match: ${targetUser.username} vs ${opponentUser?.username ?? 'Opponent'}`;

      const threadParent = interaction.client.channels.cache.get(CHANNELS.matchThreads) as TextChannel | undefined;
      let thread: ThreadChannel | undefined;

      if (threadParent) {
        try {
          thread = await threadParent.threads.create({
            name: threadName,
            type: ChannelType.PrivateThread,
            reason: `D2R 1v1 League match #${matchId} (mod-queued)`,
          }) as ThreadChannel;

          await thread.members.add(targetUser.id);
          await thread.members.add(opponentDiscordId);

          if (matchId > 0) {
            await setMatchThreadId(targetUser.id, thread.id);
            await prisma.match.update({ where: { id: matchId }, data: { threadId: thread.id } });
          }

          if (allBanned) {
            await postAllBannedEmbed(thread, targetUser.id, opponentDiscordId, 'STANDARD');
          } else {
            await postMatchAnnouncementEmbed(
              thread,
              { build1: selectedMatchup.build1, build2: selectedMatchup.build2, type: matchType },
              targetUser.id,
              opponentDiscordId,
              matchId,
            );
          }
        } catch (threadErr) {
          console.error('[/admin-queue-player] Failed to create match thread:', threadErr);
        }
      }

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Green)
            .setTitle('Match Found')
            .setDescription(
              `<@${targetUser.id}> was matched against <@${opponentDiscordId}>.\n\n` +
              (thread ? `Match thread: <#${thread.id}>` : 'Thread creation failed — check logs.')
            ),
        ],
      });

      // Notify both players in #1v1-queue
      const queueChannel = interaction.client.channels.cache.get(CHANNELS.queue) as TextChannel | undefined;
      if (queueChannel) {
        await queueChannel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Gold)
              .setTitle('Match Assigned')
              .setDescription(
                `<@${targetUser.id}> vs <@${opponentDiscordId}>` +
                (thread ? `\n\n**Thread:** <#${thread.id}>` : '')
              )
              .setTimestamp(),
          ],
        });

        await queueChannel.send({
          content: `<@${opponentDiscordId}> — you've been matched! Check ${thread ? `<#${thread.id}>` : 'your match thread'}.`,
        });
      }

    } catch (err) {
      console.error('[/admin-queue-player]', err);
      await interaction.editReply({ embeds: [buildErrorEmbed('Command failed. Try again or check logs.')] });
    }
  },
};
