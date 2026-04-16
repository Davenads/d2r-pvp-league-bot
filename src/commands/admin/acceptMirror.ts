/**
 * /admin-accept-mirror
 *
 * Mod-only QA command. Accepts a pending mirror match request on behalf of
 * the opponent player — bypasses the button click required in /request-mirror.
 * Runs the same match creation and thread flow as handleMirrorAccept.
 * Only use during testing; not intended for production match management.
 */

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
  TextChannel,
  ChannelType,
} from 'discord.js';
import type { Command } from '../../types/index.js';
import { buildErrorEmbed, EMBED_COLORS } from '../../utils/formatters.js';
import { prisma } from '../../db/client.js';
import {
  findMirrorRequestByOpponent,
  deleteMirrorRequest,
  startMirrorMatch,
  setMatchThreadId,
} from '../../services/queue.js';
import { CHANNELS } from '../../config/channels.js';
import { assertModRole } from '../../utils/modGuard.js';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-accept-mirror')
    .setDescription('Accept a pending mirror match request on behalf of a player (mod/QA only)')
    .addUserOption((opt) =>
      opt
        .setName('player')
        .setDescription('The player who received the mirror request (the opponent)')
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
      const pending = await findMirrorRequestByOpponent(targetUser.id);

      if (!pending) {
        await interaction.editReply({
          embeds: [buildErrorEmbed(`No pending mirror request found for <@${targetUser.id}>. It may have expired or already been resolved.`)],
        });
        return;
      }

      const { nonce, req } = pending;

      const season = await prisma.season.findFirst({ where: { active: true } });
      if (!season) {
        await interaction.editReply({ embeds: [buildErrorEmbed('No active season.')] });
        return;
      }

      const [p1, p2] = await Promise.all([
        prisma.player.findFirst({ where: { discordId: req.requesterId, seasonId: season.id, status: 'ACTIVE' } }),
        prisma.player.findFirst({ where: { discordId: req.opponentId, seasonId: season.id, status: 'ACTIVE' } }),
      ]);

      if (!p1 || !p2) {
        await interaction.editReply({ embeds: [buildErrorEmbed('One or both players are no longer eligible (not ACTIVE this season).') ] });
        return;
      }

      const { matchId } = await startMirrorMatch(req, season.id, p1.id, p2.id);
      await deleteMirrorRequest(nonce);

      // Create match thread
      const threadParent = interaction.client.channels.cache.get(CHANNELS.matchThreads) as TextChannel | undefined;
      let threadId: string | undefined;

      if (threadParent) {
        try {
          const thread = await threadParent.threads.create({
            name: `Match #${matchId} — Mirror`,
            type: ChannelType.PrivateThread,
            reason: `Mirror match #${matchId} (admin-accepted)`,
          });
          threadId = thread.id;
          await thread.members.add(req.requesterId);
          await thread.members.add(req.opponentId);

          await thread.send({
            content: `<@${req.requesterId}> <@${req.opponentId}>`,
            embeds: [
              new EmbedBuilder()
                .setColor(Colors.Gold)
                .setTitle(`Mirror Match #${matchId} — ${req.build} vs ${req.build}`)
                .setDescription(`<@${req.requesterId}> vs <@${req.opponentId}>\n\nBoth players are on **${req.build}**.`)
                .setFooter({ text: 'Report the result with /report-win once done.' })
                .setTimestamp(),
            ],
          });

          await setMatchThreadId(req.requesterId, threadId);
          await prisma.match.update({ where: { id: matchId }, data: { threadId } });
        } catch (threadErr) {
          console.warn('[/admin-accept-mirror] Failed to create thread:', threadErr);
        }
      }

      const queueChannel = interaction.client.channels.cache.get(CHANNELS.queue) as TextChannel | undefined;
      if (queueChannel) {
        await queueChannel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Gold)
              .setTitle('Mirror Match — Accepted (mod)')
              .addFields(
                { name: 'Player 1', value: `<@${req.requesterId}> — ${req.build}`, inline: true },
                { name: 'Player 2', value: `<@${req.opponentId}> — ${req.build}`, inline: true },
                ...(threadId ? [{ name: 'Thread', value: `<#${threadId}>`, inline: false }] : []),
              )
              .setTimestamp(),
          ],
        });
      }

      const modLogsChannel = interaction.client.channels.cache.get(CHANNELS.modLogs) as TextChannel | undefined;
      if (modLogsChannel) {
        await modLogsChannel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(EMBED_COLORS.warning)
              .setTitle('Admin: Mirror Request Accepted on Behalf of Player')
              .addFields(
                { name: 'Accepted By', value: `<@${interaction.user.id}>`, inline: true },
                { name: 'Requester', value: `<@${req.requesterId}>`, inline: true },
                { name: 'Opponent (bypassed)', value: `<@${req.opponentId}>`, inline: true },
                { name: 'Build', value: req.build, inline: true },
                { name: 'Match #', value: String(matchId), inline: true },
              )
              .setTimestamp(),
          ],
        });
      }

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Green)
            .setTitle('Mirror Request Accepted')
            .setDescription(
              `Mirror match #${matchId} created.\n\n` +
              `**Requester:** <@${req.requesterId}>\n` +
              `**Opponent:** <@${req.opponentId}>\n` +
              `**Build:** ${req.build}` +
              (threadId ? `\n\n**Thread:** <#${threadId}>` : '')
            ),
        ],
      });

    } catch (err) {
      console.error('[/admin-accept-mirror]', err);
      await interaction.editReply({ embeds: [buildErrorEmbed('Failed to accept mirror request. Check logs.')] });
    }
  },
};
