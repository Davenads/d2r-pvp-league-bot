/**
 * /admin-clear-player-state
 *
 * Mod-only recovery command. Resets a player's Redis state to idle and clears
 * any active match record for them. Does NOT touch Postgres — match history is
 * preserved. Use when a player is stuck as in_match or queued due to a failed
 * test or edge case.
 */

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
  TextChannel,
} from 'discord.js';
import type { Command } from '../../types/index.js';
import { buildErrorEmbed, EMBED_COLORS, CAIN_EMOJI } from '../../utils/formatters.js';
import { getPlayerState, setPlayerState, clearActiveMatch, leaveQueue } from '../../services/queue.js';
import { CHANNELS } from '../../config/channels.js';
import { assertModRole } from '../../utils/modGuard.js';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-clear-player-state')
    .setDescription('Reset a player\'s queue/match state to idle (mod only — Redis only, no Postgres changes)')
    .addUserOption((opt) =>
      opt
        .setName('player')
        .setDescription('The player whose state to reset')
        .setRequired(true)
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    if (!assertModRole(interaction)) {
      await interaction.editReply({ embeds: [buildErrorEmbed('You do not have permission to use this command.')] });
      return;
    }

    const targetUser = interaction.options.getUser('player', true);

    try {
      const stateBefore = await getPlayerState(targetUser.id);

      // Remove from queue list if queued
      let removedFromQueue = false;
      if (stateBefore === 'queued') {
        removedFromQueue = await leaveQueue(targetUser.id);
      }

      // Clear active match state (no-op if none exists)
      await clearActiveMatch(targetUser.id);

      // Reset to idle
      await setPlayerState(targetUser.id, 'idle');

      const cleared: string[] = [];
      if (stateBefore === 'queued') cleared.push(`removed from queue (${removedFromQueue ? 'success' : 'not found in list'})`);
      if (stateBefore === 'in_match') cleared.push('active match state cleared');
      cleared.push('state set to idle');

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Green)
            .setTitle(`${CAIN_EMOJI} Player State Cleared`)
            .addFields(
              { name: 'Player', value: `<@${targetUser.id}>`, inline: true },
              { name: 'State before', value: stateBefore, inline: true },
              { name: 'State after', value: 'idle', inline: true },
              { name: 'Actions taken', value: cleared.join('\n'), inline: false },
            )
            .setFooter({ text: 'Postgres records are unchanged. Only Redis state was reset.' }),
        ],
      });

      // Log to mod-logs
      const modLogsChannel = interaction.client.channels.cache.get(CHANNELS.modLogs) as TextChannel | undefined;
      if (modLogsChannel) {
        await modLogsChannel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(EMBED_COLORS.warning)
              .setTitle(`${CAIN_EMOJI} Player State Manually Cleared`)
              .setDescription(
                `<@${interaction.user.id}> reset the state of <@${targetUser.id}>.\n\n` +
                `**State before:** ${stateBefore}\n` +
                `**Actions:** ${cleared.join(', ')}`
              )
              .setTimestamp(),
          ],
        });
      }

    } catch (err) {
      console.error('[/admin-clear-player-state]', err);
      await interaction.editReply({ embeds: [buildErrorEmbed('Failed to clear player state. Check logs.')] });
    }
  },
};
