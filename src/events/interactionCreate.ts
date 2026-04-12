import {
  Events,
  EmbedBuilder,
  Colors,
  TextChannel,
  ThreadChannel,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import type { Interaction, ButtonInteraction, StringSelectMenuInteraction } from 'discord.js';
import type { BotClient } from '../index.js';
import { buildErrorEmbed, EMBED_COLORS } from '../utils/formatters.js';
import { prisma } from '../db/client.js';
import {
  clearActiveMatch,
  setPlayerState,
  getMirrorRequest,
  deleteMirrorRequest,
  startMirrorMatch,
  setMatchThreadId,
  getPendingMatch,
  updatePendingMatch,
  clearPendingMatch,
  setActiveMatch,
} from '../services/queue.js';
import { getMatchupRules } from '../services/matchup.js';
import { updateLadderResult } from '../services/ladder.js';
import { cacheDel } from '../services/cache.js';
import { CacheKeys } from '../types/index.js';
import type { ActiveMatchState } from '../types/index.js';
import { CHANNELS } from '../config/channels.js';
import { postMatchupSelectionEmbed, postAllBannedEmbed } from '../utils/matchupUI.js';
import type { MatchType } from '@prisma/client';

export const name = Events.InteractionCreate;
export const once = false;

export async function execute(interaction: Interaction): Promise<void> {
  const client = interaction.client as BotClient;

  // ── Slash commands ───────────────────────────────────────────────────────
  if (interaction.isChatInputCommand()) {
    const command = client.commands.get(interaction.commandName);

    if (!command) {
      console.warn(`[Commands] Unknown command: ${interaction.commandName}`);
      return;
    }

    try {
      await command.execute(interaction);
    } catch (err) {
      console.error(`[Commands] Error in /${interaction.commandName}:`, err);
      const embed = buildErrorEmbed('Something went wrong running that command. Please try again.');
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ embeds: [embed], ephemeral: true });
      } else {
        await interaction.reply({ embeds: [embed], ephemeral: true });
      }
    }
    return;
  }

  // ── Autocomplete ─────────────────────────────────────────────────────────
  if (interaction.isAutocomplete()) {
    const command = client.commands.get(interaction.commandName);
    if (!command?.autocomplete) return;

    try {
      await command.autocomplete(interaction);
    } catch (err) {
      console.error(`[Autocomplete] Error in /${interaction.commandName}:`, err);
    }
    return;
  }

  // ── String select menus ──────────────────────────────────────────────────
  if (interaction.isStringSelectMenu()) {
    const colonIdx = interaction.customId.indexOf(':');
    const action = colonIdx === -1 ? interaction.customId : interaction.customId.slice(0, colonIdx);
    const payload = colonIdx === -1 ? '' : interaction.customId.slice(colonIdx + 1);

    if (action === 'matchup_select') {
      await handleMatchupSelect(interaction, payload);
      return;
    }
  }

  // ── Button interactions ───────────────────────────────────────────────────
  if (interaction.isButton()) {
    const colonIdx = interaction.customId.indexOf(':');
    const action = colonIdx === -1 ? interaction.customId : interaction.customId.slice(0, colonIdx);
    const payload = colonIdx === -1 ? '' : interaction.customId.slice(colonIdx + 1);

    if (action === 'confirm_result' || action === 'dispute_result') {
      const matchId = parseInt(payload, 10);
      if (isNaN(matchId)) return;
      if (action === 'confirm_result') await handleConfirmResult(interaction, matchId);
      else await handleDisputeResult(interaction, matchId);
      return;
    }

    if (action === 'mirror_accept') {
      await handleMirrorAccept(interaction, payload);
      return;
    }

    if (action === 'mirror_decline') {
      await handleMirrorDecline(interaction, payload);
      return;
    }

    if (action === 'matchup_confirm') {
      await handleMatchupConfirm(interaction, payload);
      return;
    }

    if (action === 'matchup_decline') {
      await handleMatchupDecline(interaction, payload);
      return;
    }

    if (action === 'cancel_match') {
      await handleCancelMatch(interaction, payload);
      return;
    }

    if (action === 'override_banned') {
      await handleOverrideBanned(interaction, payload);
      return;
    }
  }
}

// ── Matchup select handler ────────────────────────────────────────────────────

async function handleMatchupSelect(interaction: StringSelectMenuInteraction, nonce: string): Promise<void> {
  await interaction.deferUpdate();

  try {
    const pending = await getPendingMatch(nonce);
    if (!pending) {
      await interaction.followUp({ embeds: [buildErrorEmbed('This matchup selection has expired or no longer exists.')], ephemeral: true });
      return;
    }

    const userId = interaction.user.id;
    const isP1 = userId === pending.player1DiscordId;
    const isP2 = userId === pending.player2DiscordId;

    if (!isP1 && !isP2) {
      await interaction.followUp({ embeds: [buildErrorEmbed("You aren't a participant in this match.")], ephemeral: true });
      return;
    }

    // Parse value — always stored as "build1|build2"
    const [build1, build2] = interaction.values[0].split('|');
    if (!build1 || !build2) return;

    // Store selection in Redis
    await updatePendingMatch(nonce, {
      selectedMatchup: { build1, build2 },
      selectorDiscordId: userId,
    });

    const otherPlayerId = isP1 ? pending.player2DiscordId : pending.player1DiscordId;

    // Post confirmation prompt to thread
    const confirmEmbed = new EmbedBuilder()
      .setColor(Colors.Gold)
      .setTitle('Matchup Selected')
      .setDescription(
        `<@${userId}> selected **${build1} vs ${build2}**.\n\n` +
        `<@${otherPlayerId}>, do you agree to this matchup?`
      )
      .setFooter({ text: 'The player who selected cannot confirm their own choice.' });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`matchup_confirm:${nonce}`)
        .setLabel('Agree')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`matchup_decline:${nonce}`)
        .setLabel('Change Selection')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`cancel_match:${nonce}`)
        .setLabel('Cancel Match')
        .setStyle(ButtonStyle.Danger),
    );

    const channel = interaction.channel as TextChannel | ThreadChannel | null;
    await channel?.send({ embeds: [confirmEmbed], components: [row] });
  } catch (err) {
    console.error('[matchup_select]', err);
  }
}

// ── Matchup confirm handler ───────────────────────────────────────────────────

async function handleMatchupConfirm(interaction: ButtonInteraction, nonce: string): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  try {
    const pending = await getPendingMatch(nonce);
    if (!pending) {
      await interaction.editReply({ embeds: [buildErrorEmbed('This matchup selection has expired.')] });
      return;
    }

    if (!pending.selectedMatchup) {
      await interaction.editReply({ embeds: [buildErrorEmbed('No matchup has been selected yet.')] });
      return;
    }

    const userId = interaction.user.id;
    const isP1 = userId === pending.player1DiscordId;
    const isP2 = userId === pending.player2DiscordId;

    if (!isP1 && !isP2) {
      await interaction.editReply({ embeds: [buildErrorEmbed("You aren't a participant in this match.")] });
      return;
    }

    // The selector cannot confirm their own selection
    if (userId === pending.selectorDiscordId) {
      await interaction.editReply({ embeds: [buildErrorEmbed("You can't confirm your own matchup selection. Wait for your opponent.")] });
      return;
    }

    const { build1, build2 } = pending.selectedMatchup;

    // Create Prisma Match record
    const match = await prisma.match.create({
      data: {
        seasonId: pending.seasonId,
        player1Id: pending.player1DbId,
        player2Id: pending.player2DbId,
        build1Used: build1,
        build2Used: build2,
        type: pending.matchType as MatchType,
        status: 'PENDING',
        threadId: pending.threadId,
      },
    });

    // Set ActiveMatchState in Redis
    const matchState: ActiveMatchState = {
      matchId: match.id,
      player1DiscordId: pending.player1DiscordId,
      player2DiscordId: pending.player2DiscordId,
      build1,
      build2,
      createdAt: Date.now(),
      threadId: pending.threadId,
    };
    await setActiveMatch(matchState);

    // Clear pending match from Redis
    await clearPendingMatch(nonce);

    // Post confirmed match embed to thread
    if (pending.threadId) {
      try {
        const thread = interaction.client.channels.cache.get(pending.threadId) as ThreadChannel | undefined;
        if (thread?.isThread()) {
          const confirmedEmbed = new EmbedBuilder()
            .setColor(Colors.Gold)
            .setTitle(`Match #${match.id} Locked In`)
            .setDescription(
              `**${build1}** vs **${build2}**\n\n` +
              `<@${pending.player1DiscordId}> vs <@${pending.player2DiscordId}>`
            )
            .setFooter({ text: 'Report with /report-win when done.' })
            .setTimestamp();

          const embeds = [confirmedEmbed];

          // Append matchup rules if not banned
          const rules = await getMatchupRules(build1, build2).catch(() => null);
          if (rules && !rules.isBanned) {
            const rulesEmbed = new EmbedBuilder()
              .setColor(EMBED_COLORS.rules)
              .setTitle('Matchup Rules')
              .addFields(
                { name: `${build1} Rules`, value: rules.rulesForA || '*No specific restrictions.*', inline: false },
                { name: `${build2} Rules`, value: rules.rulesForB || '*No specific restrictions.*', inline: false },
              );
            embeds.push(rulesEmbed);
          }

          await thread.send({
            content: `<@${pending.player1DiscordId}> <@${pending.player2DiscordId}>`,
            embeds,
          });
        }
      } catch (threadErr) {
        console.warn('[matchup_confirm] Failed to post to thread:', threadErr);
      }
    }

    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(Colors.Green).setTitle('Matchup Confirmed!').setDescription(`**${build1} vs ${build2}** is locked in. Good luck!`)] });
  } catch (err) {
    console.error('[matchup_confirm]', err);
    await interaction.editReply({ embeds: [buildErrorEmbed('Failed to confirm matchup. Contact a mod.')] });
  }
}

// ── Matchup decline (change) handler ─────────────────────────────────────────

async function handleMatchupDecline(interaction: ButtonInteraction, nonce: string): Promise<void> {
  await interaction.deferUpdate();

  try {
    const pending = await getPendingMatch(nonce);
    if (!pending) return;

    const userId = interaction.user.id;
    const isP1 = userId === pending.player1DiscordId;
    const isP2 = userId === pending.player2DiscordId;
    if (!isP1 && !isP2) return;

    // Clear selected matchup, go back to selection
    await updatePendingMatch(nonce, { selectedMatchup: undefined, selectorDiscordId: undefined });

    const thread = interaction.channel as ThreadChannel | null;
    if (thread) {
      if (pending.allBanned) {
        await postAllBannedEmbed(thread, nonce, pending.player1DiscordId, pending.player2DiscordId);
      } else {
        await postMatchupSelectionEmbed(thread, nonce, pending.player1DiscordId, pending.player2DiscordId, pending.availableMatchups);
      }
    }
  } catch (err) {
    console.error('[matchup_decline]', err);
  }
}

// ── Cancel match handler ──────────────────────────────────────────────────────

async function handleCancelMatch(interaction: ButtonInteraction, nonce: string): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  try {
    const pending = await getPendingMatch(nonce);
    if (!pending) {
      await interaction.editReply({ embeds: [buildErrorEmbed('Match not found or already resolved.')] });
      return;
    }

    const userId = interaction.user.id;
    const isP1 = userId === pending.player1DiscordId;
    const isP2 = userId === pending.player2DiscordId;
    if (!isP1 && !isP2) {
      await interaction.editReply({ embeds: [buildErrorEmbed("You aren't a participant in this match.")] });
      return;
    }

    // Return both players to idle
    await Promise.all([
      setPlayerState(pending.player1DiscordId, 'idle'),
      setPlayerState(pending.player2DiscordId, 'idle'),
    ]);
    await clearPendingMatch(nonce);

    // Post cancellation notice to thread
    if (pending.threadId) {
      try {
        const thread = interaction.client.channels.cache.get(pending.threadId) as ThreadChannel | undefined;
        if (thread?.isThread()) {
          await thread.send({
            embeds: [
              new EmbedBuilder()
                .setColor(EMBED_COLORS.warning)
                .setTitle('Match Cancelled')
                .setDescription(`<@${userId}> cancelled the match. Both players have been returned to idle.`)
                .setTimestamp(),
            ],
          });
          // Archive thread
          await thread.setArchived(true, 'Match cancelled before selection').catch(() => null);
        }
      } catch (threadErr) {
        console.warn('[cancel_match] Failed to post/archive thread:', threadErr);
      }
    }

    await interaction.editReply({ embeds: [new EmbedBuilder().setColor(EMBED_COLORS.warning).setTitle('Match Cancelled').setDescription('You have been returned to idle.')] });
  } catch (err) {
    console.error('[cancel_match]', err);
    await interaction.editReply({ embeds: [buildErrorEmbed('Failed to cancel match. Contact a mod.')] });
  }
}

// ── Override banned handler ───────────────────────────────────────────────────

async function handleOverrideBanned(interaction: ButtonInteraction, nonce: string): Promise<void> {
  await interaction.deferUpdate();

  try {
    const pending = await getPendingMatch(nonce);
    if (!pending) return;

    const userId = interaction.user.id;
    const isP1 = userId === pending.player1DiscordId;
    const isP2 = userId === pending.player2DiscordId;
    if (!isP1 && !isP2) return;

    // Show all matchups (including banned, prefixed with ⚠️ BANNED)
    const thread = interaction.channel as ThreadChannel | null;
    if (thread) {
      await postMatchupSelectionEmbed(
        thread,
        nonce,
        pending.player1DiscordId,
        pending.player2DiscordId,
        pending.allMatchups,
        true,  // isBanned = true → prefix labels
      );
    }
  } catch (err) {
    console.error('[override_banned]', err);
  }
}

// ── Confirm result handler ────────────────────────────────────────────────────

async function handleConfirmResult(interaction: ButtonInteraction, matchId: number): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  try {
    const match = await prisma.match.findUnique({
      where: { id: matchId },
      include: { player1: true, player2: true, winner: true },
    });

    if (!match) {
      await interaction.editReply({ embeds: [buildErrorEmbed('Match not found.')] });
      return;
    }

    if (match.status === 'CONFIRMED') {
      await interaction.editReply({ embeds: [buildErrorEmbed('This match has already been confirmed.')] });
      return;
    }

    if (match.status === 'VOIDED') {
      await interaction.editReply({ embeds: [buildErrorEmbed('This match has been voided by a mod.')] });
      return;
    }

    const isPlayer1 = match.player1.discordId === interaction.user.id;
    const isPlayer2 = match.player2.discordId === interaction.user.id;

    if (!isPlayer1 && !isPlayer2) {
      await interaction.editReply({ embeds: [buildErrorEmbed("You aren't a participant in this match.")] });
      return;
    }

    const reporterPlayer = match.winner;
    if (!reporterPlayer) {
      await interaction.editReply({ embeds: [buildErrorEmbed('No winner has been reported yet.')] });
      return;
    }

    if (reporterPlayer.discordId === interaction.user.id) {
      await interaction.editReply({
        embeds: [buildErrorEmbed("You can't confirm your own win report. Wait for your opponent to confirm.")],
      });
      return;
    }

    const loserPlayer = match.player1.id === reporterPlayer.id ? match.player2 : match.player1;

    // Confirm the match in Postgres
    await prisma.match.update({
      where: { id: matchId },
      data: { status: 'CONFIRMED', confirmedAt: new Date() },
    });

    // Update lastMatchAt for both players
    await prisma.player.updateMany({
      where: { id: { in: [reporterPlayer.id, loserPlayer.id] } },
      data: { lastMatchAt: new Date() },
    });

    // Write W/L to Google Sheets (non-fatal if sheet write fails)
    try {
      await updateLadderResult(reporterPlayer.discordId, loserPlayer.discordId, match.type);
    } catch (sheetErr) {
      console.error('[confirm_result] Sheet write-back failed:', sheetErr);
    }

    // Invalidate ladder cache so next /ladder fetch reflects the new result
    await cacheDel(CacheKeys.ladder());

    // Clear Redis state for both players
    await clearActiveMatch(reporterPlayer.discordId);
    await setPlayerState(reporterPlayer.discordId, 'idle');
    await setPlayerState(loserPlayer.discordId, 'idle');

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Green)
          .setTitle('Result Confirmed')
          .setDescription(`Match #${matchId} confirmed. Good game!`)
          .addFields(
            { name: 'Winner', value: `<@${reporterPlayer.discordId}>`, inline: true },
            { name: 'Loser', value: `<@${loserPlayer.discordId}>`, inline: true },
            { name: 'Type', value: match.type.replace('_', ' '), inline: true },
          ),
      ],
    });

    // Post result in #1v1-match-results
    const resultsChannel = interaction.client.channels.cache.get(CHANNELS.matchResults) as TextChannel | undefined;
    if (resultsChannel) {
      await resultsChannel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Green)
            .setTitle('Match Result')
            .addFields(
              { name: 'Winner', value: `<@${reporterPlayer.discordId}> (${match.build1Used})`, inline: true },
              { name: 'Loser', value: `<@${loserPlayer.discordId}> (${match.build2Used})`, inline: true },
              { name: 'Type', value: match.type.replace('_', ' '), inline: true },
              { name: 'Match #', value: String(matchId), inline: true },
            )
            .setTimestamp(),
        ],
      });
    }

    // Archive the match thread
    if (match.threadId) {
      try {
        const thread = interaction.client.channels.cache.get(match.threadId) as ThreadChannel | undefined;
        if (thread?.isThread()) await thread.setArchived(true, 'Match confirmed');
      } catch (threadErr) {
        console.warn('[confirm_result] Failed to archive thread:', threadErr);
      }
    }
  } catch (err) {
    console.error('[confirm_result]', err);
    await interaction.editReply({ embeds: [buildErrorEmbed('Failed to confirm result. Contact a mod.')] });
  }
}

// ── Dispute result handler ────────────────────────────────────────────────────

async function handleDisputeResult(interaction: ButtonInteraction, matchId: number): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  try {
    const match = await prisma.match.findUnique({
      where: { id: matchId },
      include: { player1: true, player2: true, winner: true },
    });

    if (!match) {
      await interaction.editReply({ embeds: [buildErrorEmbed('Match not found.')] });
      return;
    }

    if (match.status !== 'PENDING') {
      await interaction.editReply({ embeds: [buildErrorEmbed('This match can no longer be disputed.')] });
      return;
    }

    const isPlayer1 = match.player1.discordId === interaction.user.id;
    const isPlayer2 = match.player2.discordId === interaction.user.id;

    if (!isPlayer1 && !isPlayer2) {
      await interaction.editReply({ embeds: [buildErrorEmbed("You aren't a participant in this match.")] });
      return;
    }

    await prisma.match.update({
      where: { id: matchId },
      data: { status: 'DISPUTED' },
    });

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(EMBED_COLORS.warning)
          .setTitle('Result Disputed')
          .setDescription('The match result has been flagged as disputed. A mod will review it shortly.'),
      ],
    });

    // Ping mods in #1v1-mod-logs
    const modLogsChannel = interaction.client.channels.cache.get(CHANNELS.modLogs) as TextChannel | undefined;
    if (modLogsChannel) {
      await modLogsChannel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Red)
            .setTitle('Disputed Match Result')
            .setDescription(
              `<@${interaction.user.id}> has disputed the result of match #${matchId}.\n\n` +
              `**Players:** <@${match.player1.discordId}> vs <@${match.player2.discordId}>\n` +
              `**Reported winner:** ${match.winner ? `<@${match.winner.discordId}>` : 'Not yet reported'}\n` +
              (match.threadId ? `**Thread:** <#${match.threadId}>` : '')
            )
            .setFooter({ text: 'Use /admin-set-result to resolve.' })
            .setTimestamp(),
        ],
      });
    }
  } catch (err) {
    console.error('[dispute_result]', err);
    await interaction.editReply({ embeds: [buildErrorEmbed('Failed to dispute result. Contact a mod directly.')] });
  }
}

// ── Mirror accept handler ─────────────────────────────────────────────────────

async function handleMirrorAccept(interaction: ButtonInteraction, nonce: string): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  try {
    const req = await getMirrorRequest(nonce);

    if (!req) {
      await interaction.editReply({ embeds: [buildErrorEmbed('This mirror request has expired or already been resolved.')] });
      return;
    }

    // Only the intended opponent can accept
    if (interaction.user.id !== req.opponentId) {
      await interaction.editReply({ embeds: [buildErrorEmbed('This mirror request was not sent to you.')] });
      return;
    }

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
      await interaction.editReply({ embeds: [buildErrorEmbed('One or both players are no longer eligible.')] });
      return;
    }

    // Create the mirror match
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
          reason: `Mirror match #${matchId}`,
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
        console.warn('[mirror_accept] Failed to create thread:', threadErr);
      }
    }

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Green)
          .setTitle('Mirror Match Accepted!')
          .setDescription(
            `You've accepted the mirror match against <@${req.requesterId}>.\n\n` +
            `**Build:** ${req.build}` +
            (threadId ? `\n\nCheck <#${threadId}> for your match thread.` : '')
          ),
      ],
    });

    // Update the original request message in #1v1-queue
    const queueChannel = interaction.client.channels.cache.get(CHANNELS.queue) as TextChannel | undefined;
    if (queueChannel) {
      await queueChannel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Gold)
            .setTitle('Mirror Match — Accepted')
            .addFields(
              { name: 'Player 1', value: `<@${req.requesterId}> — ${req.build}`, inline: true },
              { name: 'Player 2', value: `<@${req.opponentId}> — ${req.build}`, inline: true },
              ...(threadId ? [{ name: 'Thread', value: `<#${threadId}>`, inline: false }] : []),
            )
            .setTimestamp(),
        ],
      });
    }
  } catch (err) {
    console.error('[mirror_accept]', err);
    await interaction.editReply({ embeds: [buildErrorEmbed('Failed to create mirror match. Contact a mod.')] });
  }
}

// ── Mirror decline handler ────────────────────────────────────────────────────

async function handleMirrorDecline(interaction: ButtonInteraction, nonce: string): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  try {
    const req = await getMirrorRequest(nonce);

    if (!req) {
      await interaction.editReply({ embeds: [buildErrorEmbed('This mirror request has already expired or been resolved.')] });
      return;
    }

    if (interaction.user.id !== req.opponentId) {
      await interaction.editReply({ embeds: [buildErrorEmbed('This mirror request was not sent to you.')] });
      return;
    }

    await deleteMirrorRequest(nonce);

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(EMBED_COLORS.warning)
          .setTitle('Mirror Request Declined')
          .setDescription('You have declined the mirror match request.'),
      ],
    });

    // Notify the requester via #1v1-queue
    const queueChannel = interaction.client.channels.cache.get(CHANNELS.queue) as TextChannel | undefined;
    if (queueChannel) {
      await queueChannel.send({
        content: `<@${req.requesterId}>`,
        embeds: [
          new EmbedBuilder()
            .setColor(EMBED_COLORS.warning)
            .setDescription(`<@${req.opponentId}> declined your mirror match request for **${req.build}**.`),
        ],
      });
    }
  } catch (err) {
    console.error('[mirror_decline]', err);
    await interaction.editReply({ embeds: [buildErrorEmbed('Something went wrong. Contact a mod.')] });
  }
}
