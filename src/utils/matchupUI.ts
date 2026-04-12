/**
 * Shared helpers for posting match UI embeds into match threads.
 * Used by /queue, /admin-forcematch, and their interactionCreate handlers.
 */

import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Colors,
} from 'discord.js';
import type { ThreadChannel } from 'discord.js';
import type { BuildPairing } from '../types/index.js';
import { EMBED_COLORS } from './formatters.js';

/**
 * Post the "all matchups are banned" embed into a thread.
 * Offers two buttons:
 *   - "Override (Bot picks randomly)" — customId: override_banned:{p1Id}:{p2Id}:{matchType}
 *   - "Re-queue both"                — customId: cancel_match:{p1Id}:{p2Id}
 *
 * @param thread     The private match thread
 * @param p1Id       Discord ID of player 1
 * @param p2Id       Discord ID of player 2
 * @param matchType  'STANDARD' | 'TOURNAMENT' — passed through to override handler
 */
export async function postAllBannedEmbed(
  thread: ThreadChannel,
  p1Id: string,
  p2Id: string,
  matchType: 'STANDARD' | 'TOURNAMENT' = 'STANDARD',
): Promise<void> {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLORS.banned)
    .setTitle('All Matchups Banned')
    .setDescription(
      `<@${p1Id}> vs <@${p2Id}>\n\n` +
      'Every possible build pairing between these two players is on the banned matchup list.\n\n' +
      '**Override** — the bot will randomly pick from all pairings (including banned).\n' +
      '**Re-queue both** — both players return to the queue.',
    )
    .setFooter({ text: 'Contact a mod if you believe this is an error.' });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`override_banned:${p1Id}:${p2Id}:${matchType}`)
      .setLabel('Override (Bot picks randomly)')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`cancel_match:${p1Id}:${p2Id}`)
      .setLabel('Re-queue both')
      .setStyle(ButtonStyle.Danger),
  );

  await thread.send({
    content: `<@${p1Id}> <@${p2Id}>`,
    embeds: [embed],
    components: [row],
  });
}

/**
 * Post the match announcement embed after the bot has randomly selected a pairing.
 * No buttons — the match record already exists.
 *
 * @param thread     The private match thread
 * @param matchup    The randomly selected BuildPairing
 * @param p1Id       Discord ID of player 1
 * @param p2Id       Discord ID of player 2
 * @param matchId    Prisma Match.id
 * @param isTournament  When true, adds a tournament note to the description
 */
export async function postMatchAnnouncementEmbed(
  thread: ThreadChannel,
  matchup: BuildPairing,
  p1Id: string,
  p2Id: string,
  matchId: number,
  isTournament = false,
): Promise<void> {
  const matchTypeLine = matchup.type === 'DEATHMATCH'
    ? 'Match type: **Deathmatch (FT2)**'
    : 'Match type: **Standard (FT4)**';

  const tournamentNote = isTournament
    ? '\n\nThis is a **tournament match** — Winner **+3 pts** | Loser **+1 pt**.'
    : '';

  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle(`Match #${matchId} Assigned`)
    .setDescription(
      `The bot has randomly selected your matchup. Both players must play these builds.\n\n` +
      tournamentNote,
    )
    .addFields(
      { name: `<@${p1Id}> plays`, value: matchup.build1, inline: true },
      { name: `<@${p2Id}> plays`, value: matchup.build2, inline: true },
      { name: 'Rules', value: matchTypeLine, inline: false },
      {
        name: 'When finished',
        value: 'The **winner** should use `/report-win` to record the result.\nFor any disputes, contact a **1v1 moderator**.',
        inline: false,
      },
    )
    .setTimestamp();

  await thread.send({
    content: `<@${p1Id}> <@${p2Id}>`,
    embeds: [embed],
  });
}
