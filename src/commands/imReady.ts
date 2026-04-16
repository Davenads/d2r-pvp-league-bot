import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
  TextChannel,
  ChannelType,
} from 'discord.js';
import type { ThreadChannel } from 'discord.js';
import type { Command } from '../types/index.js';
import { buildErrorEmbed, EMBED_COLORS, CAIN_EMOJI } from '../utils/formatters.js';
import { getForcedMatch, clearForcedMatch, getPlayerState, joinQueue, setMatchThreadId } from '../services/queue.js';
import { prisma } from '../db/client.js';
import { CHANNELS } from '../config/channels.js';
import { postAllBannedEmbed, postMatchAnnouncementEmbed } from '../utils/matchupUI.js';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('im-ready')
    .setDescription('Acknowledge a forced match assignment and enter the queue'),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const discordId = interaction.user.id;

    try {
      // Check for a pending forced match assignment
      const forced = await getForcedMatch(discordId);

      if (!forced) {
        // No forced assignment — check if they just want to confirm they're available
        const state = await getPlayerState(discordId);
        if (state === 'in_match') {
          await interaction.editReply({
            embeds: [buildErrorEmbed("You're currently in an active match. Report the result first with `/report-win`.")],
          });
          return;
        }

        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(EMBED_COLORS.warning)
              .setTitle(`${CAIN_EMOJI} No Forced Match Pending`)
              .setDescription(
                "You don't have a pending forced match assignment right now.\n\n" +
                "Use `/queue` to enter the normal match queue."
              ),
          ],
        });
        return;
      }

      // Clear the forced match flag
      await clearForcedMatch(discordId);

      // Enter the queue on their behalf (FIFO matching applies)
      const outcome = await joinQueue(discordId);

      if (!outcome.matched) {
        // Placed in queue
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Green)
              .setTitle(`${CAIN_EMOJI} Ready — Added to Queue`)
              .setDescription(
                "You've acknowledged your forced match assignment and have been added to the queue.\n\n" +
                `**Queue position:** #${outcome.position}\n\n` +
                "You'll be notified when an opponent is found."
              ),
          ],
        });

        // Notify mods
        const modQueueChannel = interaction.client.channels.cache.get(CHANNELS.modQueue) as TextChannel | undefined;
        if (modQueueChannel) {
          await modQueueChannel.send({
            embeds: [
              new EmbedBuilder()
                .setColor(Colors.Green)
                .setDescription(`<@${discordId}> acknowledged forced match and joined queue at position #${outcome.position}`)
                .setTimestamp(),
            ],
          });
        }
        return;
      }

      // Immediate match found
      const { opponentDiscordId, matchId, selectedMatchup, matchType, allBanned } = outcome;

      const opponentUser = await interaction.client.users.fetch(opponentDiscordId).catch(() => null);
      const threadName = `Match: ${interaction.user.username} vs ${opponentUser?.username ?? 'Opponent'}`;

      const threadParent = interaction.client.channels.cache.get(CHANNELS.matchThreads) as TextChannel | undefined;
      let thread: ThreadChannel | undefined;

      if (threadParent) {
        try {
          thread = await threadParent.threads.create({
            name: threadName,
            type: ChannelType.PrivateThread,
            reason: `D2R 1v1 League forced match #${matchId}`,
          }) as ThreadChannel;

          await thread.members.add(discordId);
          await thread.members.add(opponentDiscordId);

          // Update thread ID in Redis and Postgres
          if (matchId > 0) {
            await setMatchThreadId(discordId, thread.id);
            await prisma.match.update({ where: { id: matchId }, data: { threadId: thread.id } });
          }

          if (allBanned) {
            await postAllBannedEmbed(thread, discordId, opponentDiscordId, 'STANDARD');
          } else {
            await postMatchAnnouncementEmbed(
              thread,
              { build1: selectedMatchup.build1, build2: selectedMatchup.build2, type: matchType },
              discordId,
              opponentDiscordId,
              matchId,
            );
          }
        } catch (threadErr) {
          console.error('[/im-ready] Failed to create match thread:', threadErr);
        }
      }

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Gold)
            .setTitle(`${CAIN_EMOJI} Ready — Match Found!`)
            .setDescription(
              `You've been matched against <@${opponentDiscordId}>.\n\n` +
              (thread ? `Head to <#${thread.id}> for your match details.` : 'A match has been set up.')
            ),
        ],
      });

      const queueChannel = interaction.client.channels.cache.get(CHANNELS.queue) as TextChannel | undefined;
      if (queueChannel) {
        await queueChannel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Gold)
              .setTitle(`${CAIN_EMOJI} Forced Match Assigned`)
              .setDescription(
                `<@${discordId}> vs <@${opponentDiscordId}>` +
                (thread ? `\n\n**Thread:** <#${thread.id}>` : '')
              )
              .setTimestamp(),
          ],
        });
      }
    } catch (err) {
      console.error('[/im-ready]', err);
      await interaction.editReply({ embeds: [buildErrorEmbed('Command failed. Try again or contact a mod.')] });
    }
  },
};
