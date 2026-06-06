import {
  ChatInputCommandInteraction,
  ButtonInteraction,
  EmbedBuilder,
  Colors,
  TextChannel,
  ChannelType,
} from 'discord.js';
import type { ThreadChannel } from 'discord.js';
import { buildErrorEmbed, EMBED_COLORS, CAIN_EMOJI } from './formatters.js';
import { prisma } from '../db/client.js';
import {
  joinQueue,
  getPlayerState,
  getForcedMatch,
  clearForcedMatch,
  getForcedMatchThread,
  clearForcedMatchThread,
  acquireQueueJoinLock,
  releaseQueueJoinLock,
} from '../services/queue.js';
import { CHANNELS } from '../config/channels.js';
import { ROLES } from '../config/roles.js';
import { postAllBannedEmbed, postMatchAnnouncementEmbed } from './matchupUI.js';

type QueueInteraction = ChatInputCommandInteraction | ButtonInteraction;

export async function executeQueueJoin(interaction: QueueInteraction): Promise<void> {
  const discordId = interaction.user.id;

  const locked = await acquireQueueJoinLock(discordId);
  if (!locked) {
    await interaction.editReply({ embeds: [buildErrorEmbed('Already processing a queue request. Try again in a moment.')] });
    return;
  }

  try {
    const season = await prisma.season.findFirst({ where: { active: true } });
    if (!season) {
      await interaction.editReply({ embeds: [buildErrorEmbed('No active season. Registration and queueing are currently closed.')] });
      return;
    }

    const player = await prisma.player.findFirst({
      where: { discordId, seasonId: season.id },
    });

    if (!player) {
      await interaction.editReply({ embeds: [buildErrorEmbed("You aren't registered for this season. Use `/register` to join.")] });
      return;
    }

    if (player.status === 'REMOVED') {
      await interaction.editReply({ embeds: [buildErrorEmbed('You have been removed from the league and cannot queue.')] });
      return;
    }

    if (player.status === 'VACATION') {
      await interaction.editReply({ embeds: [buildErrorEmbed('You are currently on vacation. Contact a mod to return to active status.')] });
      return;
    }

    const currentState = await getPlayerState(discordId);

    if (currentState === 'queued') {
      await interaction.editReply({ embeds: [buildErrorEmbed("You're already in the queue. Wait for an opponent.")] });
      return;
    }

    const forcedAssignment = await getForcedMatch(discordId);
    if (forcedAssignment) {
      await clearForcedMatch(discordId);

      // Archive the private notification thread if one was created by the scheduler (H1)
      const notifThreadId = await getForcedMatchThread(discordId);
      if (notifThreadId) {
        await clearForcedMatchThread(discordId);
        try {
          const notifThread = interaction.client.channels.cache.get(notifThreadId);
          if (notifThread?.isThread() && !notifThread.archived) {
            await notifThread.send({
              embeds: [
                new EmbedBuilder()
                  .setColor(Colors.Green)
                  .setDescription('✅ Assignment acknowledged — player has joined the queue.')
                  .setTimestamp(),
              ],
            });
            await notifThread.setArchived(true, 'Forced assignment acknowledged').catch(() => undefined);
          }
        } catch {
          // Non-critical — thread may have already been archived or deleted
        }
      }
    }

    const outcome = await joinQueue(discordId);

    if (!outcome.matched) {
      const description = forcedAssignment
        ? "You've acknowledged your forced match assignment and been added to the queue. You'll be notified when an opponent is found."
        : "You've been added to the match queue. You'll be notified when an opponent is found.";

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(EMBED_COLORS.info)
            .setTitle(`${CAIN_EMOJI} Joined Queue`)
            .setDescription(description)
            .addFields({ name: 'Queue Position', value: `#${outcome.position}`, inline: true })
            .setFooter({ text: 'Queue order is private. You will be matched FIFO.' }),
        ],
      });

      const modQueueChannel = interaction.client.channels.cache.get(CHANNELS.modQueue) as TextChannel | undefined;
      if (modQueueChannel) {
        await modQueueChannel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(EMBED_COLORS.info)
              .setDescription(`A player joined the queue — position #${outcome.position}${forcedAssignment ? ' (forced match acknowledged)' : ''}`)
              .setTimestamp(),
          ],
        });
      }
      return;
    }

    // ── Match found ──────────────────────────────────────────────────────────

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
          reason: `D2R 1v1 League match #${matchId}`,
        }) as ThreadChannel;

        await thread.members.add(discordId);
        await thread.members.add(opponentDiscordId);

        // Add all 1v1 Moderator role members to the thread
        const guild = interaction.guild;
        if (guild) {
          const modRole = guild.roles.cache.get(ROLES.mod)
            ?? await guild.roles.fetch(ROLES.mod).catch(() => null);
          if (modRole) {
            for (const [modId] of modRole.members) {
              await thread.members.add(modId).catch(() => {
                console.warn(`[queueJoin] Could not add mod ${modId} to thread`);
              });
            }
            // Ping the mod role so all mods receive a notification
            await thread.send({ content: `<@&${ROLES.mod}>` }).catch(() => {
              console.warn('[queueJoin] Could not post mod ping in thread');
            });
          }
        }

        if (matchId > 0) {
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
        console.error('[queueJoin] Failed to create match thread:', threadErr);
      }
    }

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Green)
          .setTitle(`${CAIN_EMOJI} Match Found!`)
          .setDescription(
            `You've been matched against <@${opponentDiscordId}>.\n\n` +
            (thread ? `Head to <#${thread.id}> for your match details.` : 'A match has been set up.')
          ),
      ],
    });

    const resultsChannel = interaction.client.channels.cache.get(CHANNELS.matchResults) as TextChannel | undefined;
    if (resultsChannel) {
      await resultsChannel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Gold)
            .setTitle(`${CAIN_EMOJI} Match Assigned`)
            .setDescription(
              `<@${discordId}> vs <@${opponentDiscordId}>` +
              (thread ? `\n\n**Thread:** <#${thread.id}>` : '')
            )
            .setTimestamp(),
        ],
      });

      await resultsChannel.send({
        content: `<@${opponentDiscordId}> — you've been matched! Check ${thread ? `<#${thread.id}>` : 'your match thread'}.`,
      });
    }
  } catch (err) {
    console.error('[queueJoin]', err);
    await interaction.editReply({ embeds: [buildErrorEmbed('Failed to join queue. Try again or contact a mod.')] });
  } finally {
    await releaseQueueJoinLock(discordId);
  }
}
