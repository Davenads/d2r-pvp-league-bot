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
import type { Interaction, ButtonInteraction } from 'discord.js';
import type { BotClient } from '../index.js';
import { buildErrorEmbed, EMBED_COLORS, CAIN_EMOJI } from '../utils/formatters.js';
import { processMatchResult } from '../utils/matchResult.js';
import { executeQueueJoin } from '../utils/queueJoin.js';
import { prisma } from '../db/client.js';
import {
  getMirrorRequest,
  deleteMirrorRequest,
  startMirrorMatch,
  addActiveMatch,
  getAllowedMatchups,
  selectRandomPairing,
  reQueueBothPlayers,
} from '../services/queue.js';
import { CHANNELS } from '../config/channels.js';
import { postAllBannedEmbed, postMatchAnnouncementEmbed } from '../utils/matchupUI.js';
import type { MatchType } from '@prisma/client';
import { recordReadyCheck } from '../services/readyCheck.js';
import {
  requestExtension,
  acceptExtension,
  declineExtension,
  getPendingExtendRequest,
} from '../services/matchExtend.js';

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

  // ── Button interactions ───────────────────────────────────────────────────
  if (interaction.isButton()) {
    const colonIdx = interaction.customId.indexOf(':');
    const action = colonIdx === -1 ? interaction.customId : interaction.customId.slice(0, colonIdx);
    const payload = colonIdx === -1 ? '' : interaction.customId.slice(colonIdx + 1);

    if (action === 'queue_join') {
      await interaction.deferReply({ ephemeral: true });
      await executeQueueJoin(interaction);
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

    if (action === 'report_win') {
      // payload format: {matchId}:{winnerId}
      await handleReportWinButton(interaction, payload);
      return;
    }

    if (action === 'archive_thread') {
      await handleArchiveThread(interaction, payload);
      return;
    }

    if (action === 'cancel_match') {
      // payload format: {p1Id}:{p2Id}
      await handleCancelMatch(interaction, payload);
      return;
    }

    if (action === 'override_banned') {
      // payload format: {p1Id}:{p2Id}:{matchType}
      await handleOverrideBanned(interaction, payload);
      return;
    }

    if (action === 'rc_checkin') {
      // payload: {matchId}
      await handleRcCheckin(interaction, payload);
      return;
    }

    if (action === 'extend_req') {
      // payload: {matchId}
      await handleExtendRequest(interaction, payload);
      return;
    }

    if (action === 'extend_accept') {
      // payload: {matchId}
      await handleExtendAccept(interaction, payload);
      return;
    }

    if (action === 'extend_decline') {
      // payload: {matchId}
      await handleExtendDecline(interaction, payload);
      return;
    }

    if (action === 'action_register') {
      await interaction.reply({
        ephemeral: true,
        content:
          '**How to Register**\n\n' +
          'Use the `/register` command and select your build from the autocomplete list.\n' +
          'You can register up to 5 builds. Pick the ones you plan to play this season.\n\n' +
          'Once registered, you\'ll appear on the leaderboard and can enter the queue.',
      });
      return;
    }
  }
}

// ── Report win button handler ─────────────────────────────────────────────────
// Triggered by the "Player X Won" buttons posted in a match thread at match creation.
// payload: {matchId}:{winnerId}

async function handleReportWinButton(interaction: ButtonInteraction, payload: string): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  try {
    const colonIdx = payload.indexOf(':');
    const matchId = colonIdx === -1 ? parseInt(payload, 10) : parseInt(payload.slice(0, colonIdx), 10);
    const winnerId = colonIdx === -1 ? '' : payload.slice(colonIdx + 1);

    if (!matchId || !winnerId) {
      await interaction.editReply({ embeds: [buildErrorEmbed('Invalid button data.')] });
      return;
    }

    // Verify the clicker is a participant in this match
    const match = await prisma.match.findUnique({
      where: { id: matchId },
      include: { player1: true, player2: true },
    });

    if (!match) {
      await interaction.editReply({ embeds: [buildErrorEmbed('Match not found. Contact a mod.')] });
      return;
    }

    const clickerId = interaction.user.id;
    const { player1, player2 } = match;
    if (clickerId !== player1.discordId && clickerId !== player2.discordId) {
      await interaction.editReply({ embeds: [buildErrorEmbed("You aren't a participant in this match.")] });
      return;
    }

    const result = await processMatchResult(
      interaction.client,
      matchId,
      winnerId,
      clickerId,
      false,             // test_rule not supported via button — use /report-win for that
      interaction.channelId,
    );

    if (!result.success) {
      await interaction.editReply({ embeds: [buildErrorEmbed(result.errorMessage)] });
      return;
    }

    await interaction.editReply({ embeds: [result.embed] });
  } catch (err) {
    console.error('[report_win button]', err);
    await interaction.editReply({ embeds: [buildErrorEmbed('Failed to record result. Try again or contact a mod.')] });
  }
}

// ── Archive thread handler ────────────────────────────────────────────────────
// Triggered by the "Archive Thread" button posted in a match thread on result confirmation.
// payload: {p1Id}:{p2Id}

async function handleArchiveThread(interaction: ButtonInteraction, payload: string): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  try {
    const parts = payload.split(':');
    const p1Id = parts[0];
    const p2Id = parts[1];

    if (!p1Id || !p2Id) {
      await interaction.editReply({ embeds: [buildErrorEmbed('Invalid button data.')] });
      return;
    }

    if (interaction.user.id !== p1Id && interaction.user.id !== p2Id) {
      await interaction.editReply({ embeds: [buildErrorEmbed("You aren't a participant in this match.")] });
      return;
    }

    const thread = interaction.channel as ThreadChannel | null;
    if (thread?.isThread()) {
      await thread.setArchived(true, 'Archived by match participant');
      await interaction.editReply({ content: 'Thread archived.' });
    } else {
      await interaction.editReply({ embeds: [buildErrorEmbed('Could not find the thread to archive.')] });
    }
  } catch (err) {
    console.error('[archive_thread]', err);
    await interaction.editReply({ embeds: [buildErrorEmbed('Failed to archive. Contact a mod.')] });
  }
}

// ── Cancel match handler ──────────────────────────────────────────────────────
// Triggered when players choose "Re-queue both" on the all-banned embed.
// payload: {p1Id}:{p2Id}

async function handleCancelMatch(interaction: ButtonInteraction, payload: string): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  try {
    const parts = payload.split(':');
    const p1Id = parts[0];
    const p2Id = parts[1];

    if (!p1Id || !p2Id) {
      await interaction.editReply({ embeds: [buildErrorEmbed('Invalid button data.')] });
      return;
    }

    const userId = interaction.user.id;
    if (userId !== p1Id && userId !== p2Id) {
      await interaction.editReply({ embeds: [buildErrorEmbed("You aren't a participant in this match.")] });
      return;
    }

    // Re-queue both players
    await reQueueBothPlayers(p1Id, p2Id);

    // Post notice to thread
    const thread = interaction.channel as ThreadChannel | null;
    if (thread?.isThread()) {
      await thread.send({
        embeds: [
          new EmbedBuilder()
            .setColor(EMBED_COLORS.warning)
            .setTitle(`${CAIN_EMOJI} Match Cancelled — Both Players Re-queued`)
            .setDescription(
              `<@${userId}> chose to re-queue. Both <@${p1Id}> and <@${p2Id}> have been returned to the queue.`
            )
            .setTimestamp(),
        ],
      });
      await thread.setArchived(true, 'Match cancelled — re-queued').catch(() => null);
    }

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(EMBED_COLORS.warning)
          .setTitle(`${CAIN_EMOJI} Re-queued`)
          .setDescription('Both players have been returned to the queue.'),
      ],
    });
  } catch (err) {
    console.error('[cancel_match]', err);
    await interaction.editReply({ embeds: [buildErrorEmbed('Failed to re-queue. Contact a mod.')] });
  }
}

// ── Override banned handler ───────────────────────────────────────────────────
// Triggered when players choose "Override (Bot picks randomly)" on the all-banned embed.
// payload: {p1Id}:{p2Id}:{matchType}

async function handleOverrideBanned(interaction: ButtonInteraction, payload: string): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  try {
    const parts = payload.split(':');
    const p1Id = parts[0];
    const p2Id = parts[1];
    const matchTypeRaw = parts[2] ?? 'STANDARD';

    if (!p1Id || !p2Id) {
      await interaction.editReply({ embeds: [buildErrorEmbed('Invalid button data.')] });
      return;
    }

    const userId = interaction.user.id;
    if (userId !== p1Id && userId !== p2Id) {
      await interaction.editReply({ embeds: [buildErrorEmbed("You aren't a participant in this match.")] });
      return;
    }

    const matchType = (matchTypeRaw === 'TOURNAMENT' ? 'TOURNAMENT' : 'STANDARD') as MatchType;

    // Look up both players in the active season
    const season = await prisma.season.findFirst({ where: { active: true } });
    if (!season) {
      await interaction.editReply({ embeds: [buildErrorEmbed('No active season.')] });
      return;
    }

    const [p1Record, p2Record] = await Promise.all([
      prisma.player.findFirst({ where: { discordId: p1Id, seasonId: season.id } }),
      prisma.player.findFirst({ where: { discordId: p2Id, seasonId: season.id } }),
    ]);

    if (!p1Record || !p2Record) {
      await interaction.editReply({ embeds: [buildErrorEmbed('One or both players could not be found.')] });
      return;
    }

    // Fetch ALL pairings (including banned) — pick randomly from all
    const { all } = await getAllowedMatchups(p1Record, p2Record);
    const selected = selectRandomPairing(all);

    // Create Prisma Match record
    const match = await prisma.match.create({
      data: {
        seasonId: season.id,
        player1Id: p1Record.id,
        player2Id: p2Record.id,
        build1Used: selected.build1,
        build2Used: selected.build2,
        type: matchType,
        status: 'PENDING',
      },
    });

    // Register match in both players' active match SETs
    await addActiveMatch(match.id, p1Id, p2Id);

    // Post announcement in thread
    const thread = interaction.channel as ThreadChannel | null;
    if (thread?.isThread()) {
      // Update threadId in match record
      await prisma.match.update({ where: { id: match.id }, data: { threadId: thread.id } });

      await postMatchAnnouncementEmbed(
        thread,
        selected,
        p1Id,
        p2Id,
        match.id,
        matchType === 'TOURNAMENT',
      );
    }

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Gold)
          .setTitle(`${CAIN_EMOJI} Override Applied`)
          .setDescription(`Match #${match.id} created with **${selected.build1} vs ${selected.build2}**.`),
      ],
    });
  } catch (err) {
    console.error('[override_banned]', err);
    await interaction.editReply({ embeds: [buildErrorEmbed('Failed to apply override. Contact a mod.')] });
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

        await prisma.match.update({ where: { id: matchId }, data: { threadId } });
      } catch (threadErr) {
        console.warn('[mirror_accept] Failed to create thread:', threadErr);
      }
    }

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Green)
          .setTitle(`${CAIN_EMOJI} Mirror Match Accepted!`)
          .setDescription(
            `You've accepted the mirror match against <@${req.requesterId}>.\n\n` +
            `**Build:** ${req.build}` +
            (threadId ? `\n\nCheck <#${threadId}> for your match thread.` : '')
          ),
      ],
    });

    // Post match announcement to #1v1-match-results
    const resultsChannel = interaction.client.channels.cache.get(CHANNELS.matchResults) as TextChannel | undefined;
    if (resultsChannel) {
      await resultsChannel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Gold)
            .setTitle(`${CAIN_EMOJI} Mirror Match — Accepted`)
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

// ── Ready check handler ───────────────────────────────────────────────────────
// payload: {matchId}

async function handleRcCheckin(interaction: ButtonInteraction, payload: string): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  try {
    const matchId = parseInt(payload, 10);
    if (!matchId) {
      await interaction.editReply({ embeds: [buildErrorEmbed('Invalid button data.')] });
      return;
    }

    const match = await prisma.match.findUnique({
      where: { id: matchId },
      include: { player1: true, player2: true },
    });

    if (!match) {
      await interaction.editReply({ embeds: [buildErrorEmbed('Match not found.')] });
      return;
    }

    const clickerId = interaction.user.id;
    if (clickerId !== match.player1.discordId && clickerId !== match.player2.discordId) {
      await interaction.editReply({ embeds: [buildErrorEmbed("You aren't a participant in this match.")] });
      return;
    }

    if (match.status !== 'PENDING') {
      await interaction.editReply({ embeds: [buildErrorEmbed('This match has already been resolved.')] });
      return;
    }

    const result = await recordReadyCheck(matchId, clickerId);

    if (!result.success) {
      const nextSec = Math.floor(result.nextEligibleMs / 1000);
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(EMBED_COLORS.warning)
            .setTitle(`${CAIN_EMOJI} Already Checked In`)
            .setDescription(`You're on cooldown. Next check-in available: <t:${nextSec}:R>.`),
        ],
      });
      return;
    }

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Green)
          .setTitle(`${CAIN_EMOJI} Ready Check Logged`)
          .setDescription(`Check-in #${result.count} recorded. Next check-in available in 4 hours.`)
          .setFooter({ text: 'Keep checking in to stay ahead of your opponent.' }),
      ],
    });

    // Ping the opponent publicly in the thread so they know their match partner is ready
    const opponentId =
      clickerId === match.player1.discordId ? match.player2.discordId : match.player1.discordId;

    if (interaction.channel && 'send' in interaction.channel) {
      await interaction.channel.send(
        `<@${opponentId}> — <@${clickerId}> has checked in and is ready to play. (Check-in #${result.count})`
      );
    }
  } catch (err) {
    console.error('[rc_checkin]', err);
    await interaction.editReply({ embeds: [buildErrorEmbed('Failed to record ready check. Try again.')] });
  }
}

// ── Extend request handler ────────────────────────────────────────────────────
// payload: {matchId}

async function handleExtendRequest(interaction: ButtonInteraction, payload: string): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  try {
    const matchId = parseInt(payload, 10);
    if (!matchId) {
      await interaction.editReply({ embeds: [buildErrorEmbed('Invalid button data.')] });
      return;
    }

    const match = await prisma.match.findUnique({
      where: { id: matchId },
      include: { player1: true, player2: true },
    });

    if (!match) {
      await interaction.editReply({ embeds: [buildErrorEmbed('Match not found.')] });
      return;
    }

    const requesterId = interaction.user.id;
    if (requesterId !== match.player1.discordId && requesterId !== match.player2.discordId) {
      await interaction.editReply({ embeds: [buildErrorEmbed("You aren't a participant in this match.")] });
      return;
    }

    if (match.status !== 'PENDING') {
      await interaction.editReply({ embeds: [buildErrorEmbed('This match has already been resolved.')] });
      return;
    }

    const opponentId = requesterId === match.player1.discordId
      ? match.player2.discordId
      : match.player1.discordId;

    const result = await requestExtension(matchId, requesterId);

    if (result.status === 'already_extended') {
      await interaction.editReply({
        embeds: [buildErrorEmbed('This match has already been extended once. No further extensions are allowed.')],
      });
      return;
    }

    if (result.status === 'request_pending') {
      const isSelf = result.existingRequesterId === requesterId;
      await interaction.editReply({
        embeds: [
          buildErrorEmbed(
            isSelf
              ? 'You already have a pending extension request. Waiting for your opponent to respond.'
              : 'An extension request is already pending for this match.',
          ),
        ],
      });
      return;
    }

    // Post accept/decline buttons in the thread for the opponent
    const thread = interaction.channel as ThreadChannel | null;
    if (thread?.isThread()) {
      const acceptRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`extend_accept:${matchId}`)
          .setLabel('Accept Extension')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`extend_decline:${matchId}`)
          .setLabel('Decline Extension')
          .setStyle(ButtonStyle.Danger),
      );

      await thread.send({
        content: `<@${opponentId}>`,
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Yellow)
            .setTitle(`${CAIN_EMOJI} Extension Requested`)
            .setDescription(
              `<@${requesterId}> is requesting a 3-day extension for this match.\n\n` +
              'Click **Accept Extension** to agree. The match deadline shifts by 3 days and ready check counts reset.\n\n' +
              '**Only one extension is allowed.** If declined, the original deadline stands.'
            )
            .setFooter({ text: 'This request expires in 48 hours.' }),
        ],
        components: [acceptRow],
      });
    }

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Yellow)
          .setTitle(`${CAIN_EMOJI} Extension Requested`)
          .setDescription(`Your extension request has been sent. Waiting for <@${opponentId}> to respond.`),
      ],
    });
  } catch (err) {
    console.error('[extend_req]', err);
    await interaction.editReply({ embeds: [buildErrorEmbed('Failed to request extension. Try again.')] });
  }
}

// ── Extend accept handler ─────────────────────────────────────────────────────
// payload: {matchId}

async function handleExtendAccept(interaction: ButtonInteraction, payload: string): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  try {
    const matchId = parseInt(payload, 10);
    if (!matchId) {
      await interaction.editReply({ embeds: [buildErrorEmbed('Invalid button data.')] });
      return;
    }

    const match = await prisma.match.findUnique({
      where: { id: matchId },
      include: { player1: true, player2: true },
    });

    if (!match) {
      await interaction.editReply({ embeds: [buildErrorEmbed('Match not found.')] });
      return;
    }

    const result = await acceptExtension(
      matchId,
      interaction.user.id,
      match.player1.discordId,
      match.player2.discordId,
    );

    if (result.status === 'no_request') {
      await interaction.editReply({
        embeds: [buildErrorEmbed('No pending extension request found. It may have expired.')],
      });
      return;
    }

    if (result.status === 'wrong_player') {
      await interaction.editReply({
        embeds: [buildErrorEmbed("You can't accept your own extension request.")],
      });
      return;
    }

    // Post confirmation in thread
    const thread = interaction.channel as ThreadChannel | null;
    if (thread?.isThread()) {
      await thread.send({
        content: `<@${match.player1.discordId}> <@${match.player2.discordId}>`,
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Green)
            .setTitle(`${CAIN_EMOJI} Extension Granted`)
            .setDescription(
              'Both players agreed to a 3-day extension. Ready check counts have been reset.\n\n' +
              '**This is the only extension allowed.** The match must be completed within the new window.'
            )
            .setTimestamp(),
        ],
      });
    }

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.Green)
          .setTitle(`${CAIN_EMOJI} Extension Accepted`)
          .setDescription('You accepted the extension. The match deadline has been extended by 3 days.'),
      ],
    });
  } catch (err) {
    console.error('[extend_accept]', err);
    await interaction.editReply({ embeds: [buildErrorEmbed('Failed to accept extension. Contact a mod.')] });
  }
}

// ── Extend decline handler ────────────────────────────────────────────────────
// payload: {matchId}

async function handleExtendDecline(interaction: ButtonInteraction, payload: string): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  try {
    const matchId = parseInt(payload, 10);
    if (!matchId) {
      await interaction.editReply({ embeds: [buildErrorEmbed('Invalid button data.')] });
      return;
    }

    const pending = await getPendingExtendRequest(matchId);
    await declineExtension(matchId);

    // Notify the requester in thread
    if (pending) {
      const thread = interaction.channel as ThreadChannel | null;
      if (thread?.isThread()) {
        await thread.send({
          content: `<@${pending.requesterId}>`,
          embeds: [
            new EmbedBuilder()
              .setColor(EMBED_COLORS.warning)
              .setTitle(`${CAIN_EMOJI} Extension Declined`)
              .setDescription('Your extension request was declined. The original match deadline stands.'),
          ],
        });
      }
    }

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(EMBED_COLORS.warning)
          .setTitle(`${CAIN_EMOJI} Extension Declined`)
          .setDescription('You declined the extension request. The original deadline stands.'),
      ],
    });
  } catch (err) {
    console.error('[extend_decline]', err);
    await interaction.editReply({ embeds: [buildErrorEmbed('Failed to decline extension. Contact a mod.')] });
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
          .setTitle(`${CAIN_EMOJI} Mirror Request Declined`)
          .setDescription('You have declined the mirror match request.'),
      ],
    });

    // Notify the requester via #1v1-match-results
    const resultsChannel = interaction.client.channels.cache.get(CHANNELS.matchResults) as TextChannel | undefined;
    if (resultsChannel) {
      await resultsChannel.send({
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
