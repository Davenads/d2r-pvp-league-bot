/**
 * /admin-forcematch
 *
 * Mod-only command to create a tournament match between two registered players.
 * - Computes all allowed build pairings via getAllowedMatchups
 * - Stores a PendingMatchSelection in Redis with matchType TOURNAMENT
 * - Creates a private match thread and posts the matchup selection UI
 * - No Prisma Match record is created until both players confirm the matchup
 * - Points on result: winner +3, loser +1 (handled by updateLadderResult)
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
import { randomUUID } from 'crypto';
import type { Command, PendingMatchSelection } from '../../types/index.js';
import { buildErrorEmbed, EMBED_COLORS } from '../../utils/formatters.js';
import { prisma } from '../../db/client.js';
import {
  getAllowedMatchups,
  storePendingMatch,
  updatePendingMatch,
  setPlayerState,
  getPlayerState,
} from '../../services/queue.js';
import { CHANNELS } from '../../config/channels.js';
import { assertModRole } from '../../utils/modGuard.js';
import { postMatchupSelectionEmbed, postAllBannedEmbed } from '../../utils/matchupUI.js';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-forcematch')
    .setDescription('Force a tournament match between two players — winner +3 pts, loser +1 pt (mod only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption((opt) =>
      opt.setName('player1').setDescription('First player').setRequired(true)
    )
    .addUserOption((opt) =>
      opt.setName('player2').setDescription('Second player').setRequired(true)
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    if (!await assertModRole(interaction)) return;

    const p1User = interaction.options.getUser('player1', true);
    const p2User = interaction.options.getUser('player2', true);

    if (p1User.id === p2User.id) {
      await interaction.editReply({ embeds: [buildErrorEmbed('player1 and player2 must be different users.')] });
      return;
    }

    try {
      const season = await prisma.season.findFirst({ where: { active: true } });
      if (!season) {
        await interaction.editReply({ embeds: [buildErrorEmbed('No active season.')] });
        return;
      }

      const [p1Record, p2Record] = await Promise.all([
        prisma.player.findFirst({ where: { discordId: p1User.id, seasonId: season.id } }),
        prisma.player.findFirst({ where: { discordId: p2User.id, seasonId: season.id } }),
      ]);

      if (!p1Record) {
        await interaction.editReply({ embeds: [buildErrorEmbed(`**${p1User.username}** is not registered this season.`)] });
        return;
      }
      if (!p2Record) {
        await interaction.editReply({ embeds: [buildErrorEmbed(`**${p2User.username}** is not registered this season.`)] });
        return;
      }
      if (p1Record.status === 'REMOVED') {
        await interaction.editReply({ embeds: [buildErrorEmbed(`**${p1User.username}** has been removed from the league.`)] });
        return;
      }
      if (p2Record.status === 'REMOVED') {
        await interaction.editReply({ embeds: [buildErrorEmbed(`**${p2User.username}** has been removed from the league.`)] });
        return;
      }

      // Warn if either player is already in a match — mod can proceed anyway
      const [p1State, p2State] = await Promise.all([
        getPlayerState(p1User.id),
        getPlayerState(p2User.id),
      ]);
      const stateWarning =
        (p1State === 'in_match' ? `⚠️ **${p1User.username}** is currently marked as in_match.\n` : '') +
        (p2State === 'in_match' ? `⚠️ **${p2User.username}** is currently marked as in_match.\n` : '');

      // Compute all allowed matchup combinations
      const { available, all, allBanned } = await getAllowedMatchups(p1Record, p2Record);

      // Generate nonce and store pending match
      const nonce = randomUUID();
      const pending: PendingMatchSelection = {
        nonce,
        seasonId: season.id,
        player1DiscordId: p1User.id,
        player2DiscordId: p2User.id,
        player1DbId: p1Record.id,
        player2DbId: p2Record.id,
        availableMatchups: available,
        allMatchups: all,
        allBanned,
        matchType: 'TOURNAMENT',
        createdAt: Date.now(),
      };
      await storePendingMatch(pending);

      // Set both players to in_match
      await Promise.all([
        setPlayerState(p1User.id, 'in_match'),
        setPlayerState(p2User.id, 'in_match'),
      ]);

      // Create private match thread
      const threadParent = interaction.client.channels.cache.get(CHANNELS.matchThreads) as TextChannel | undefined;
      let thread: ThreadChannel | undefined;

      if (threadParent) {
        try {
          thread = await threadParent.threads.create({
            name: `Tournament: ${p1User.username} vs ${p2User.username}`,
            type: ChannelType.PrivateThread,
            reason: `D2R 1v1 League tournament match — awaiting matchup selection`,
          }) as ThreadChannel;

          await thread.members.add(p1User.id);
          await thread.members.add(p2User.id);

          // Save thread ID into pending match
          await updatePendingMatch(nonce, { threadId: thread.id });

          // Post matchup selection UI
          if (allBanned) {
            await postAllBannedEmbed(thread, nonce, p1User.id, p2User.id);
          } else {
            await postMatchupSelectionEmbed(thread, nonce, p1User.id, p2User.id, available);
          }
        } catch (threadErr) {
          console.error('[/admin-forcematch] Failed to create match thread:', threadErr);
        }
      }

      // Post public notification to #1v1-queue
      const queueChannel = interaction.client.channels.cache.get(CHANNELS.queue) as TextChannel | undefined;
      if (queueChannel) {
        await queueChannel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Gold)
              .setTitle('Tournament Match Assigned')
              .setDescription(
                `<@${p1User.id}> vs <@${p2User.id}> — awaiting matchup selection\n` +
                `**Points:** Winner **+3** | Loser **+1**` +
                (thread ? `\n\n**Thread:** <#${thread.id}>` : '')
              )
              .setTimestamp(),
          ],
        });
      }

      // Mod log
      const logChannel = interaction.client.channels.cache.get(CHANNELS.modLogs) as TextChannel | undefined;
      if (logChannel) {
        await logChannel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(EMBED_COLORS.warning)
              .setTitle('Admin: Tournament Match Created')
              .addFields(
                { name: 'Created By', value: `<@${interaction.user.id}>`, inline: true },
                { name: 'Player 1', value: `<@${p1User.id}>`, inline: true },
                { name: 'Player 2', value: `<@${p2User.id}>`, inline: true },
                { name: 'Nonce', value: nonce, inline: false },
                ...(thread ? [{ name: 'Thread', value: `<#${thread.id}>`, inline: false }] : []),
              )
              .setTimestamp(),
          ],
        });
      }

      // Ephemeral reply to mod
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Green)
            .setTitle('Tournament Match Created')
            .setDescription(
              (stateWarning ? stateWarning + '\n' : '') +
              `Tournament match created between <@${p1User.id}> and <@${p2User.id}>.\n\n` +
              `Awaiting matchup selection in thread.` +
              (thread ? `\n\n**Thread:** <#${thread.id}>` : '')
            )
            .setFooter({ text: 'Winner +3 pts | Loser +1 pt — applied on result confirm.' })
            .setTimestamp(),
        ],
      });
    } catch (err) {
      console.error('[/admin-forcematch]', err);
      await interaction.editReply({ embeds: [buildErrorEmbed('Command failed. Check server logs.')] });
    }
  },
};
