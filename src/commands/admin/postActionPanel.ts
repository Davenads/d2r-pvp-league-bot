/**
 * /admin-post-action-panel
 *
 * Posts (or refreshes) the persistent Register / Join Queue action panel
 * in the #1v1-leaderboard-and-queue channel. The panel sits below the
 * leaderboard embed and gives players one-click access to the queue.
 *
 * If a previous panel message exists (Redis-tracked), it is deleted first
 * so the new one is always at the bottom. Message ID is stored in Redis.
 */

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Colors,
  TextChannel,
} from 'discord.js';
import type { Command } from '../../types/index.js';
import { CacheKeys } from '../../types/index.js';
import { cacheGet, cacheSet } from '../../services/cache.js';
import { CHANNELS } from '../../config/channels.js';
import { EMBED_COLORS, CAIN_EMOJI } from '../../utils/formatters.js';
import { assertModRole } from '../../utils/modGuard.js';

const ACTION_PANEL_TTL = 30 * 24 * 60 * 60; // 30 days

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-post-action-panel')
    .setDescription('Post or refresh the Register/Join Queue action panel in the leaderboard channel (mod only)'),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    if (!await assertModRole(interaction)) return;

    try {
      const channel = interaction.client.channels.cache.get(CHANNELS.leaderboard) as TextChannel | undefined;
      if (!channel) {
        await interaction.editReply({ content: 'Leaderboard channel not found in cache.' });
        return;
      }

      // Delete the previous panel message if we have its ID
      const storedMsgId = await cacheGet<string>(CacheKeys.actionPanelMsgId());
      if (storedMsgId) {
        try {
          const existing = await channel.messages.fetch(storedMsgId);
          await existing.delete();
        } catch {
          // Message already deleted or inaccessible — fine, continue
        }
      }

      const embed = new EmbedBuilder()
        .setColor(Colors.Gold)
        .setTitle(`${CAIN_EMOJI} Ready to Play?`)
        .setDescription(
          'Register for the league or jump into the match queue.\n\n' +
          'Use **Register** if this is your first time, or **Join Queue** if you\'re already signed up.'
        )
        .setFooter({ text: 'Use /register to sign up. Use /queue to enter the queue.' });

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('queue_join')
          .setLabel('Join Queue')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('action_register')
          .setLabel('Register')
          .setStyle(ButtonStyle.Success),
      );

      const msg = await channel.send({ embeds: [embed], components: [row] });
      await cacheSet(CacheKeys.actionPanelMsgId(), msg.id, ACTION_PANEL_TTL);

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(EMBED_COLORS.success)
            .setTitle(`${CAIN_EMOJI} Action Panel Posted`)
            .setDescription(`Action panel posted to <#${CHANNELS.leaderboard}>.`),
        ],
      });
    } catch (err) {
      console.error('[/admin-post-action-panel]', err);
      await interaction.editReply({ content: 'Failed to post action panel. Check logs.' });
    }
  },
};
