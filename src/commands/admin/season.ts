import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  TextChannel,
} from 'discord.js';
import type { Command } from '../../types/index.js';
import { CacheKeys } from '../../types/index.js';
import { prisma } from '../../db/client.js';
import { EMBED_COLORS, CAIN_EMOJI } from '../../utils/formatters.js';
import { assertModRole } from '../../utils/modGuard.js';
import { clearLadderForNewSeason } from '../../services/ladder.js';
import { leaveQueue, removeActiveMatch, resolvePlayerStateAfterMatch } from '../../services/queue.js';
import { getRedisClient } from '../../services/cache.js';
import { updateLeaderboardEmbed } from '../../services/leaderboardEmbed.js';
import { CHANNELS } from '../../config/channels.js';
import { logActivity } from '../../utils/activityLogger.js';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-season')
    .setDescription('Manage league seasons (mod only)')
    .addSubcommand((sub) =>
      sub
        .setName('open')
        .setDescription('Open a new season (closes any currently active season)')
        .addStringOption((opt) =>
          opt
            .setName('name')
            .setDescription('Season name, e.g. "Season 1"')
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('close')
        .setDescription('Close the currently active season')
    )
    .addSubcommand((sub) =>
      sub
        .setName('status')
        .setDescription('Show current season info')
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    if (!await assertModRole(interaction)) return;

    const sub = interaction.options.getSubcommand(true);

    try {
      if (sub === 'open') {
        const newSeasonName = interaction.options.getString('name', true).trim();

        // Gather current state for the confirmation embed
        const currentSeason = await prisma.season.findFirst({ where: { active: true } });
        const playerCount = await prisma.player.count({ where: { status: { notIn: ['REMOVED'] } } });
        const pendingMatchCount = await prisma.match.count({ where: { status: 'PENDING' } });

        // Build the confirmation embed showing exactly what will be reset
        const infoEmbed = new EmbedBuilder()
          .setColor(Colors.Orange)
          .setTitle(`${CAIN_EMOJI} Open New Season — Confirm Reset`)
          .setDescription(
            `You are about to open **${newSeasonName}** and reset all league data.\n` +
            `Everything listed below will be cleared immediately and **cannot be undone**.`
          )
          .addFields(
            { name: 'Current Season', value: currentSeason ? currentSeason.name : 'None', inline: true },
            {
              name: 'Active Since',
              value: currentSeason
                ? `<t:${Math.floor(currentSeason.startedAt.getTime() / 1000)}:F>`
                : 'N/A',
              inline: true,
            },
            { name: '\u200b', value: '\u200b', inline: true },
            { name: 'Players to Reset', value: `${playerCount} (will be marked REMOVED)`, inline: true },
            { name: 'Pending Matches to Void', value: String(pendingMatchCount), inline: true },
            { name: 'Ladder Sheet', value: 'All player rows will be cleared', inline: true },
          )
          .setFooter({ text: 'Expires in 5 minutes. Only you can confirm this action.' });

        const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId('season_open_confirm')
            .setLabel('Open Season & Reset Data')
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId('season_open_cancel')
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary),
        );

        await interaction.editReply({ embeds: [infoEmbed], components: [actionRow] });
        const reply = await interaction.fetchReply();

        // Await button click — 5-minute window, invoking mod only
        let btn;
        try {
          btn = await reply.awaitMessageComponent({
            componentType: ComponentType.Button,
            filter: (i) => i.user.id === interaction.user.id,
            time: 5 * 60 * 1000,
          });
        } catch {
          // Timed out — remove buttons, leave embed as-is
          await interaction.editReply({ components: [] }).catch(() => undefined);
          return;
        }

        if (btn.customId === 'season_open_cancel') {
          void logActivity(btn.client, {
            type: 'button',
            action: 'season_open_cancel',
            label: 'Season Open Cancelled',
            user: { id: btn.user.id, username: btn.user.username, displayName: btn.user.displayName },
            channelId: btn.channelId,
            guildId: btn.guildId,
            timestamp: btn.createdAt,
          });
          await btn.deferUpdate();
          await interaction.editReply({
            embeds: [
              new EmbedBuilder()
                .setColor(Colors.DarkGrey)
                .setTitle(`${CAIN_EMOJI} Cancelled`)
                .setDescription('No changes were made.')
                .setTimestamp(),
            ],
            components: [],
          });
          return;
        }

        // Confirmed — run the full reset sequence
        void logActivity(btn.client, {
          type: 'button',
          action: 'season_open_confirm',
          label: 'Season Open Confirmed',
          user: { id: btn.user.id, username: btn.user.username, displayName: btn.user.displayName },
          context: `New season: ${newSeasonName}`,
          channelId: btn.channelId,
          guildId: btn.guildId,
          timestamp: btn.createdAt,
        });
        await btn.deferUpdate();

        const redis = getRedisClient();

        // Fetch all data needed before making any mutations
        const pendingMatches = await prisma.match.findMany({
          where: { status: 'PENDING' },
          include: { player1: true, player2: true },
        });

        const affectedPlayers = await prisma.player.findMany({
          where: { status: { notIn: ['REMOVED'] } },
          select: { discordId: true },
        });

        // 1. Close the current season
        if (currentSeason) {
          await prisma.season.update({
            where: { id: currentSeason.id },
            data: { active: false, endedAt: new Date() },
          });
        }

        // 2. Void all PENDING matches + clean up Redis state per match
        for (const match of pendingMatches) {
          await prisma.match.update({ where: { id: match.id }, data: { status: 'VOIDED' } });
          await removeActiveMatch(match.id, match.player1.discordId, match.player2.discordId);
          await resolvePlayerStateAfterMatch(match.player1.discordId);
          await resolvePlayerStateAfterMatch(match.player2.discordId);
          if (match.threadId) {
            const thread = interaction.client.channels.cache.get(match.threadId);
            if (thread?.isThread()) await thread.setArchived(true).catch(() => undefined);
          }
        }

        // 3. Bulk-mark all non-REMOVED players as REMOVED
        await prisma.player.updateMany({
          where: { status: { notIn: ['REMOVED'] } },
          data: { status: 'REMOVED', removedAt: new Date() },
        });

        // 4. Per-player Redis cleanup
        for (const { discordId } of affectedPlayers) {
          await leaveQueue(discordId);
          await resolvePlayerStateAfterMatch(discordId);
        }

        // 5. Clear Redis queue list and ladder cache
        await redis.del(CacheKeys.queue());
        await redis.del(CacheKeys.ladder());

        // 6. Clear the Ladder sheet (non-fatal)
        try {
          await clearLadderForNewSeason();
        } catch (sheetErr) {
          console.error('[admin-season open] Ladder sheet clear failed:', sheetErr);
        }

        // 7. Create the new season
        const newSeason = await prisma.season.create({
          data: { name: newSeasonName, active: true },
        });

        // 8. Refresh leaderboard embed to show empty slate
        await updateLeaderboardEmbed(interaction.client);

        // 9. Post public summary to #1v1-match-results
        const resultsChannel = interaction.client.channels.cache.get(CHANNELS.matchResults) as TextChannel | undefined;
        if (resultsChannel) {
          await resultsChannel.send({
            embeds: [
              new EmbedBuilder()
                .setColor(Colors.Orange)
                .setTitle(`${CAIN_EMOJI} New Season — League Reset`)
                .setDescription(
                  `**${newSeason.name}** is now active. All player registrations have been cleared.\n` +
                  `Use \`/register\` to sign up for the new season.`
                )
                .addFields(
                  { name: 'Players Reset', value: String(affectedPlayers.length), inline: true },
                  { name: 'Matches Voided', value: String(pendingMatches.length), inline: true },
                  { name: 'Season ID', value: String(newSeason.id), inline: true },
                )
                .setTimestamp(),
            ],
          });
        }

        // 10. Update the ephemeral reply with success summary
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Green)
              .setTitle(`${CAIN_EMOJI} Season Opened`)
              .setDescription(`**${newSeason.name}** is now active. Players can register.`)
              .addFields(
                { name: 'Season ID', value: String(newSeason.id), inline: true },
                { name: 'Started', value: `<t:${Math.floor(newSeason.startedAt.getTime() / 1000)}:F>`, inline: true },
                { name: 'Players Reset', value: String(affectedPlayers.length), inline: true },
                { name: 'Matches Voided', value: String(pendingMatches.length), inline: true },
              )
              .setTimestamp(),
          ],
          components: [],
        });

        return;
      }

      if (sub === 'close') {
        const season = await prisma.season.findFirst({ where: { active: true } });
        if (!season) {
          await interaction.editReply({
            embeds: [new EmbedBuilder()
              .setColor(EMBED_COLORS.warning)
              .setTitle(`${CAIN_EMOJI} No Active Season`)
              .setDescription('There is no active season to close.')],
          });
          return;
        }

        await prisma.season.update({
          where: { id: season.id },
          data: { active: false, endedAt: new Date() },
        });

        const playerCount = await prisma.player.count({ where: { seasonId: season.id } });
        const matchCount = await prisma.match.count({ where: { seasonId: season.id } });

        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Red)
              .setTitle(`${CAIN_EMOJI} Season Closed`)
              .setDescription(`**${season.name}** has been closed.`)
              .addFields(
                { name: 'Players', value: String(playerCount), inline: true },
                { name: 'Matches', value: String(matchCount), inline: true },
              )
              .setTimestamp(),
          ],
        });
        return;
      }

      if (sub === 'status') {
        const season = await prisma.season.findFirst({ where: { active: true } });

        if (!season) {
          // Check if there are any past seasons
          const latest = await prisma.season.findFirst({ orderBy: { id: 'desc' } });
          if (!latest) {
            await interaction.editReply({
              embeds: [new EmbedBuilder()
                .setColor(EMBED_COLORS.warning)
                .setTitle(`${CAIN_EMOJI} No Seasons Found`)
                .setDescription('No seasons have been created yet. Use `/admin-season open` to start one.')],
            });
            return;
          }

          await interaction.editReply({
            embeds: [new EmbedBuilder()
              .setColor(EMBED_COLORS.warning)
              .setTitle(`${CAIN_EMOJI} No Active Season`)
              .setDescription(`The most recent season was **${latest.name}**, which has ended.`)
              .addFields(
                { name: 'Ended', value: latest.endedAt ? `<t:${Math.floor(latest.endedAt.getTime() / 1000)}:F>` : 'Unknown', inline: true },
              )],
          });
          return;
        }

        const playerCount = await prisma.player.count({ where: { seasonId: season.id } });
        const matchCount = await prisma.match.count({
          where: { seasonId: season.id, status: 'CONFIRMED' },
        });

        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Green)
              .setTitle(`${CAIN_EMOJI} Active Season`)
              .setDescription(`**${season.name}** is currently running.`)
              .addFields(
                { name: 'Season ID', value: String(season.id), inline: true },
                { name: 'Started', value: `<t:${Math.floor(season.startedAt.getTime() / 1000)}:F>`, inline: true },
                { name: 'Registered Players', value: String(playerCount), inline: true },
                { name: 'Confirmed Matches', value: String(matchCount), inline: true },
              )
              .setTimestamp(),
          ],
        });
      }
    } catch (err) {
      console.error('[/admin-season]', err);
      await interaction.editReply({
        embeds: [new EmbedBuilder()
          .setColor(EMBED_COLORS.error)
          .setTitle('Error')
          .setDescription('Command failed. Check server logs.')],
      });
    }
  },
};
