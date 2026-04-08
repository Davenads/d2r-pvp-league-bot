import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
  TextChannel,
  ChannelType,
} from 'discord.js';
import type { Command } from '../types/index.js';
import { buildErrorEmbed, EMBED_COLORS } from '../utils/formatters.js';
import { prisma } from '../db/client.js';
import { joinQueue, getPlayerState, setMatchThreadId } from '../services/queue.js';
import { getMatchupRules } from '../services/matchup.js';
import { CHANNELS } from '../config/channels.js';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Enter the match queue'),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const discordId = interaction.user.id;

    try {
      // Check active season
      const season = await prisma.season.findFirst({ where: { active: true } });
      if (!season) {
        await interaction.editReply({ embeds: [buildErrorEmbed('No active season. Registration and queueing are currently closed.')] });
        return;
      }

      // Check player registration
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

      // Check current state
      const currentState = await getPlayerState(discordId);

      if (currentState === 'queued') {
        await interaction.editReply({ embeds: [buildErrorEmbed("You're already in the queue. Use `/im-ready` to acknowledge a match assignment, or wait for an opponent.")] });
        return;
      }

      if (currentState === 'in_match') {
        await interaction.editReply({ embeds: [buildErrorEmbed("You're currently in an active match. Report the result first with `/report-win`.")] });
        return;
      }

      // Join the queue / attempt immediate match
      const outcome = await joinQueue(discordId);

      if (!outcome.matched) {
        // Added to queue — confirm to player
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(EMBED_COLORS.info)
              .setTitle('Joined Queue')
              .setDescription("You've been added to the match queue. You'll be notified when an opponent is found.")
              .addFields({ name: 'Queue Position', value: `#${outcome.position}`, inline: true })
              .setFooter({ text: 'Queue order is private. You will be matched FIFO.' }),
          ],
        });

        // Post to mod-queue channel for visibility
        const modQueueChannel = interaction.client.channels.cache.get(CHANNELS.modQueue) as TextChannel | undefined;
        if (modQueueChannel) {
          await modQueueChannel.send({
            embeds: [
              new EmbedBuilder()
                .setColor(EMBED_COLORS.info)
                .setDescription(`<@${discordId}> joined the queue — position #${outcome.position}`)
                .setTimestamp(),
            ],
          });
        }
        return;
      }

      // ── Match found ──────────────────────────────────────────────────────────

      const { matchId, opponentDiscordId, yourBuild, opponentBuild } = outcome;

      // Fetch matchup rules for the thread
      const rules = await getMatchupRules(yourBuild, opponentBuild).catch(() => null);

      // Create private match thread
      const threadParent = interaction.client.channels.cache.get(CHANNELS.matchThreads) as TextChannel | undefined;
      let threadId: string | undefined;

      if (threadParent) {
        try {
          const thread = await threadParent.threads.create({
            name: `Match #${matchId}`,
            type: ChannelType.PrivateThread,
            reason: `D2R 1v1 League match #${matchId}`,
          });

          threadId = thread.id;

          // Add both players to the thread
          await thread.members.add(discordId);
          await thread.members.add(opponentDiscordId);

          // Build the match embed
          const matchEmbed = new EmbedBuilder()
            .setColor(Colors.Gold)
            .setTitle(`Match #${matchId} — ${yourBuild} vs ${opponentBuild}`)
            .setDescription(
              `<@${discordId}> vs <@${opponentDiscordId}>\n\n` +
              `**${interaction.user.username}** is playing **${yourBuild}**\n` +
              `**Opponent** is playing **${opponentBuild}**`
            )
            .setFooter({ text: 'Report the result with /report-win once your match is done.' })
            .setTimestamp();

          const embeds = [matchEmbed];

          // Append matchup rules if available and not banned
          if (rules && !rules.isBanned) {
            const rulesEmbed = new EmbedBuilder()
              .setColor(EMBED_COLORS.rules)
              .setTitle('Matchup Rules')
              .addFields(
                { name: `${yourBuild} Rules`, value: rules.rulesForA || '*No specific restrictions.*', inline: false },
                { name: `${opponentBuild} Rules`, value: rules.rulesForB || '*No specific restrictions.*', inline: false },
              );
            embeds.push(rulesEmbed);
          }

          await thread.send({ content: `<@${discordId}> <@${opponentDiscordId}>`, embeds });

          // Save thread ID to Redis
          await setMatchThreadId(discordId, threadId);

          // Update Postgres Match with thread ID
          await prisma.match.update({ where: { id: matchId }, data: { threadId } });
        } catch (threadErr) {
          console.error('[/queue] Failed to create match thread:', threadErr);
        }
      }

      // Ephemeral reply to the joining player
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Green)
            .setTitle('Match Found!')
            .setDescription(
              `You've been matched against <@${opponentDiscordId}>.\n\n` +
              `**Your build:** ${yourBuild}\n` +
              `**Opponent's build:** ${opponentBuild}` +
              (threadId ? `\n\nHead to <#${threadId}> for the full rules.` : '')
            ),
        ],
      });

      // Post public match assignment to #1v1-queue
      const queueChannel = interaction.client.channels.cache.get(CHANNELS.queue) as TextChannel | undefined;
      if (queueChannel) {
        await queueChannel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Gold)
              .setTitle('Match Assigned')
              .addFields(
                { name: 'Player 1', value: `<@${discordId}> — ${yourBuild}`, inline: true },
                { name: 'Player 2', value: `<@${opponentDiscordId}> — ${opponentBuild}`, inline: true },
                ...(threadId ? [{ name: 'Thread', value: `<#${threadId}>`, inline: false }] : []),
              )
              .setTimestamp(),
          ],
        });
      }

      // Notify opponent (they were already in queue, so they need a DM or queue channel ping)
      const queueNotifyChannel = interaction.client.channels.cache.get(CHANNELS.queue) as TextChannel | undefined;
      if (queueNotifyChannel) {
        await queueNotifyChannel.send({
          content: `<@${opponentDiscordId}> — you've been matched! Check ${threadId ? `<#${threadId}>` : 'your match thread'}.`,
        });
      }
    } catch (err) {
      console.error('[/queue]', err);
      await interaction.editReply({ embeds: [buildErrorEmbed('Failed to join queue. Try again or contact a mod.')] });
    }
  },
};
