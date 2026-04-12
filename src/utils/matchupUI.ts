/**
 * Shared helpers for posting matchup selection UI into match threads.
 * Used by /queue and /admin-forcematch (and their interactionCreate handlers).
 */

import {
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ButtonBuilder,
  ButtonStyle,
  Colors,
} from 'discord.js';
import type { ThreadChannel } from 'discord.js';
import type { BuildPairing } from '../types/index.js';
import { EMBED_COLORS } from './formatters.js';

/**
 * Post the matchup selection embed + select menu into a thread.
 *
 * @param thread       The private match thread to post into
 * @param nonce        Match nonce (used in component customIds)
 * @param player1Id    Discord ID of player 1
 * @param player2Id    Discord ID of player 2
 * @param matchups     Build pairings to offer as options
 * @param isBanned     When true, prefix each option label with "⚠️ BANNED — "
 */
export async function postMatchupSelectionEmbed(
  thread: ThreadChannel,
  nonce: string,
  player1Id: string,
  player2Id: string,
  matchups: BuildPairing[],
  isBanned = false,
): Promise<void> {
  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle('Choose Your Matchup')
    .setDescription(
      `<@${player1Id}> vs <@${player2Id}>\n\n` +
      'Select the build pairing for this match. Either player can choose.',
    )
    .setFooter({ text: 'Either player can select. The other player must then confirm.' });

  const options = matchups.map((p) => {
    const label = isBanned ? `⚠️ BANNED — ${p.build1} vs ${p.build2}` : `${p.build1} vs ${p.build2}`;
    return new StringSelectMenuOptionBuilder()
      .setLabel(label.slice(0, 100))  // Discord label max = 100 chars
      .setValue(`${p.build1}|${p.build2}`);
  });

  const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`matchup_select:${nonce}`)
      .setPlaceholder('Select a build matchup...')
      .addOptions(options),
  );

  const cancelRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`cancel_match:${nonce}`)
      .setLabel('Cancel Match')
      .setStyle(ButtonStyle.Danger),
  );

  await thread.send({
    content: `<@${player1Id}> <@${player2Id}>`,
    embeds: [embed],
    components: [selectRow, cancelRow],
  });
}

/**
 * Post the "all matchups are banned" embed into a thread with Cancel / Play Anyway buttons.
 */
export async function postAllBannedEmbed(
  thread: ThreadChannel,
  nonce: string,
  player1Id: string,
  player2Id: string,
): Promise<void> {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLORS.banned)
    .setTitle('All Matchups Banned')
    .setDescription(
      `<@${player1Id}> vs <@${player2Id}>\n\n` +
      'Every possible build pairing between these two players is on the banned matchup list.\n\n' +
      'Use **Play Anyway** to override and pick a banned matchup, or **Cancel Match** to abort.',
    )
    .setFooter({ text: 'Contact a mod if you believe this is an error.' });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`cancel_match:${nonce}`)
      .setLabel('Cancel Match')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`override_banned:${nonce}`)
      .setLabel('Play Anyway (Override)')
      .setStyle(ButtonStyle.Secondary),
  );

  await thread.send({
    content: `<@${player1Id}> <@${player2Id}>`,
    embeds: [embed],
    components: [row],
  });
}
