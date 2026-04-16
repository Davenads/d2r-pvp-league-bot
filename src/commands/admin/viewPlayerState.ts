/**
 * /admin-view-player-state
 *
 * Mod-only diagnostic command. Displays a player's current Redis state and active
 * match info without modifying anything. Useful for debugging stuck states before
 * deciding whether to use /admin-clear-player-state.
 */

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
} from 'discord.js';
import type { Command } from '../../types/index.js';
import { buildErrorEmbed, EMBED_COLORS, CAIN_EMOJI } from '../../utils/formatters.js';
import { getPlayerState, getActiveMatch, getQueuePosition } from '../../services/queue.js';
import { prisma } from '../../db/client.js';
import { assertModRole } from '../../utils/modGuard.js';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-view-player-state')
    .setDescription("View a player's current queue/match state without modifying it (mod only)")
    .addUserOption((opt) =>
      opt
        .setName('player')
        .setDescription('The player to inspect')
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
      // Redis state
      const redisState = await getPlayerState(targetUser.id);
      const activeMatch = await getActiveMatch(targetUser.id);

      let queuePosition = '-';
      if (redisState === 'queued') {
        const pos = await getQueuePosition(targetUser.id);
        queuePosition = pos > 0 ? `#${pos}` : 'In queue (position unknown)';
      }

      // Postgres player record
      const season = await prisma.season.findFirst({ where: { active: true } });
      const player = season
        ? await prisma.player.findFirst({
            where: { discordId: targetUser.id, seasonId: season.id },
          })
        : null;

      const stateColor = redisState === 'idle'
        ? Colors.Green
        : redisState === 'queued'
        ? Colors.Yellow
        : Colors.Red; // in_match

      const embed = new EmbedBuilder()
        .setColor(stateColor)
        .setTitle(`${CAIN_EMOJI} Player State: ${targetUser.username}`)
        .addFields(
          { name: 'Discord ID', value: targetUser.id, inline: true },
          { name: 'Redis State', value: redisState, inline: true },
          { name: 'Queue Position', value: queuePosition, inline: true },
        );

      // Active match info
      if (activeMatch) {
        embed.addFields(
          { name: 'Active Match ID', value: String(activeMatch.matchId), inline: true },
          { name: 'Opponent', value: `<@${activeMatch.player1DiscordId === targetUser.id ? activeMatch.player2DiscordId : activeMatch.player1DiscordId}>`, inline: true },
          { name: 'Thread', value: activeMatch.threadId ? `<#${activeMatch.threadId}>` : 'None', inline: true },
        );
      } else {
        embed.addFields({ name: 'Active Match', value: 'None', inline: false });
      }

      // Postgres info
      if (player) {
        embed.addFields(
          { name: 'DB Status', value: player.status, inline: true },
          { name: 'Warnings', value: String(player.warnings), inline: true },
          { name: 'Last Match', value: player.lastMatchAt ? player.lastMatchAt.toLocaleDateString() : 'Never', inline: true },
        );
      } else {
        embed.addFields({ name: 'DB Record', value: 'Not registered for active season', inline: false });
      }

      embed.setFooter({ text: 'Read-only — use /admin-clear-player-state to reset.' });

      await interaction.editReply({ embeds: [embed] });

    } catch (err) {
      console.error('[/admin-view-player-state]', err);
      await interaction.editReply({ embeds: [buildErrorEmbed('Failed to retrieve player state. Check logs.')] });
    }
  },
};
