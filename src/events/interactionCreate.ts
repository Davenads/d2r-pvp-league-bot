import {
  Events,
  EmbedBuilder,
  Colors,
  TextChannel,
  ThreadChannel,
  ChannelType,
} from 'discord.js';
import type { Interaction, ButtonInteraction } from 'discord.js';
import type { BotClient } from '../index.js';
import { buildErrorEmbed, EMBED_COLORS, CAIN_EMOJI } from '../utils/formatters.js';
import { executeQueueJoin } from '../utils/queueJoin.js';
import { prisma } from '../db/client.js';
import {
  clearActiveMatch,
  setPlayerState,
  getMirrorRequest,
  deleteMirrorRequest,
  startMirrorMatch,
  setMatchThreadId,
  setActiveMatch,
  getAllowedMatchups,
  selectRandomPairing,
  reQueueBothPlayers,
} from '../services/queue.js';
import type { ActiveMatchState } from '../types/index.js';
import { CHANNELS } from '../config/channels.js';
import { postAllBannedEmbed, postMatchAnnouncementEmbed } from '../utils/matchupUI.js';
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

    // Set ActiveMatchState in Redis
    const matchState: ActiveMatchState = {
      matchId: match.id,
      player1DiscordId: p1Id,
      player2DiscordId: p2Id,
      build1: selected.build1,
      build2: selected.build2,
      createdAt: Date.now(),
    };
    await setActiveMatch(matchState);

    // Post announcement in thread
    const thread = interaction.channel as ThreadChannel | null;
    if (thread?.isThread()) {
      // Update threadId in match record
      await prisma.match.update({ where: { id: match.id }, data: { threadId: thread.id } });
      const updatedState: ActiveMatchState = { ...matchState, threadId: thread.id };
      await setActiveMatch(updatedState);

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
          .setTitle(`${CAIN_EMOJI} Mirror Match Accepted!`)
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
