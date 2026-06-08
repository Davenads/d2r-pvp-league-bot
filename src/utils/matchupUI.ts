/**
 * Shared helpers for posting match UI embeds into match threads.
 * Used by /queue, /admin-force-match, and their interactionCreate handlers.
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
import { EMBED_COLORS, buildClassRulesEmbed } from './formatters.js';
import { getClassEmoji, CAIN_EMOJI } from './classEmojis.js';
import { getClassFromBuild } from './buildList.js';
import { getClassRules } from '../services/content.js';

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
    .setTitle(`${CAIN_EMOJI} All Matchups Banned`)
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
  const [p1User, p2User] = await Promise.all([
    thread.client.users.fetch(p1Id).catch(() => null),
    thread.client.users.fetch(p2Id).catch(() => null),
  ]);
  const p1Name = p1User?.displayName ?? `<@${p1Id}>`;
  const p2Name = p2User?.displayName ?? `<@${p2Id}>`;

  const matchTypeLine = matchup.type === 'DEATHMATCH'
    ? 'Match type: **Deathmatch (FT2)**'
    : 'Match type: **Standard (FT4)**';

  const tournamentNote = isTournament
    ? '\n\nThis is a **tournament match** — Winner **+2 pts** | Loser **+1 pt**.'
    : '';

  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle(`${CAIN_EMOJI} Match #${matchId} Assigned`)
    .setDescription(
      `The bot has randomly selected your matchup. Both players must play these builds.` +
      tournamentNote,
    )
    .addFields(
      { name: `${p1Name} plays`, value: `${getClassEmoji(matchup.build1)} ${matchup.build1}`, inline: true },
      { name: `${p2Name} plays`, value: `${getClassEmoji(matchup.build2)} ${matchup.build2}`, inline: true },
      { name: 'Rules', value: matchTypeLine, inline: false },
      {
        name: 'When finished',
        value: 'Use the **winner buttons** at the bottom of this thread to record the result.\nFor test rule matches, use `/report-win` with the `test_rule` option.\nFor disputes, contact a **1v1 moderator**.',
        inline: false,
      },
    )
    .setTimestamp();

  await thread.send({
    content: `<@${p1Id}> <@${p2Id}>`,
    embeds: [embed],
  });

  // ── Post class rules ──────────────────────────────────────────────────────
  // Wrapped in try/catch — a rules fetch failure must not break the match flow.
  try {
    // Class rules — deduplicated if both builds share the same class
    const classMap = await getClassRules();
    const class1 = getClassFromBuild(matchup.build1);
    const class2 = getClassFromBuild(matchup.build2);
    const classesToPost = class1 === class2 ? [class1] : [class1, class2];

    for (const className of classesToPost) {
      const entry = classMap.get(className);
      if (!entry) continue;
      const classEmbeds = buildClassRulesEmbed(className, entry);
      for (const classEmbed of classEmbeds) {
        await thread.send({ embeds: [classEmbed] });
      }
    }
  } catch (rulesErr) {
    console.error('[matchupUI] Failed to post rules to thread:', rulesErr);
  }

  // ── Bottom command panel ───────────────────────────────────────────────────
  // Duplicate of key match info + all action buttons, kept at the bottom so
  // players don't need to scroll up. Stadium-requested layout (answer #6).
  await postMatchBottomPanel(thread, matchId, matchup, p1Id, p2Id, p1Name, p2Name);
}

/**
 * Posts the persistent "command panel" at the bottom of the match thread.
 * Contains a compact matchup recap and all action buttons:
 *   Row 1: P1 Won | P2 Won  (Report Win — same handler as announcement embed)
 *   Row 2: I'm Ready (Ready Check) | Request Extension
 *
 * Called at the end of postMatchAnnouncementEmbed so it always sits at the
 * bottom of the thread. Also callable independently (e.g. after rules are re-posted).
 */
export async function postMatchBottomPanel(
  thread: ThreadChannel,
  matchId: number,
  matchup: BuildPairing,
  p1Id: string,
  p2Id: string,
  p1DisplayName?: string,
  p2DisplayName?: string,
): Promise<void> {
  const p1Name = p1DisplayName ?? `<@${p1Id}>`;
  const p2Name = p2DisplayName ?? `<@${p2Id}>`;

  const matchTypeLine = matchup.type === 'DEATHMATCH'
    ? 'Deathmatch — **FT2**'
    : 'Standard — **FT4**';

  const recap = new EmbedBuilder()
    .setColor(Colors.DarkGold)
    .setTitle(`${CAIN_EMOJI} Match #${matchId} — Quick Reference`)
    .addFields(
      { name: `${p1Name}`, value: `${getClassEmoji(matchup.build1)} ${matchup.build1}`, inline: true },
      { name: `${p2Name}`, value: `${getClassEmoji(matchup.build2)} ${matchup.build2}`, inline: true },
      { name: 'Match Type', value: matchTypeLine, inline: false },
      {
        name: 'Ready Check',
        value:
          'Click **I\'m Ready** to log your availability (once every 4 hours).\n' +
          'If the match isn\'t played within 3 days, the player with more check-ins wins a half-point result.',
        inline: false,
      },
      {
        name: 'Extension',
        value: 'Click **Request Extension** if you need 3 more days. Both players must agree. One extension allowed.',
        inline: false,
      },
    )
    .setFooter({ text: 'For disputes, contact a 1v1 moderator directly.' });

  const reportRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`report_win:${matchId}:${p1Id}`)
      .setLabel(`${p1Name} Won`)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`report_win:${matchId}:${p2Id}`)
      .setLabel(`${p2Name} Won`)
      .setStyle(ButtonStyle.Primary),
  );

  const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`rc_checkin:${matchId}`)
      .setLabel("I'm Ready")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`extend_req:${matchId}`)
      .setLabel('Request Extension')
      .setStyle(ButtonStyle.Secondary),
  );

  await thread.send({
    embeds: [recap],
    components: [reportRow, actionRow],
  });
}
