/**
 * /admin-post-info-hub
 *
 * Posts (or refreshes) the persistent button-based info hub in the channel
 * where the command is run. Designed for #1v1-rules-and-info.
 *
 * The hub contains 6 buttons. Each button sends an ephemeral-only response
 * to the clicking player:
 *   Row 1: Register | Join Queue (actually queues) | Valid Builds
 *   Row 2: Report Wins | Commands | Rules
 *
 * If a previous hub message exists (Redis-tracked), it is deleted first
 * so the new one is always the latest message. Both channel ID and message ID
 * are stored in Redis as JSON.
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
import { EMBED_COLORS, CAIN_EMOJI } from '../../utils/formatters.js';
import { assertModRole } from '../../utils/modGuard.js';

const INFO_HUB_TTL = 30 * 24 * 60 * 60; // 30 days

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-post-info-hub')
    .setDescription('Post or refresh the button-based info hub (run from #1v1-rules-and-info) (mod only)'),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    if (!await assertModRole(interaction)) return;

    try {
      const channel = interaction.channel as TextChannel | null;
      if (!channel) {
        await interaction.editReply({ content: 'Could not resolve the current channel.' });
        return;
      }

      // Delete the previous hub message if we have its location
      const stored = await cacheGet<{ channelId: string; messageId: string }>(CacheKeys.infoHubMsgId());
      if (stored) {
        try {
          const prevChannel = interaction.client.channels.cache.get(stored.channelId) as TextChannel | undefined;
          if (prevChannel) {
            const prevMsg = await prevChannel.messages.fetch(stored.messageId);
            await prevMsg.delete();
          }
        } catch {
          // Message already deleted or inaccessible — continue
        }
      }

      const embed = new EmbedBuilder()
        .setColor(Colors.DarkGold)
        .setTitle(`${CAIN_EMOJI} What is this?`)
        .setDescription(
          'A structured 1v1 PvP ladder for Diablo 2 Resurrected.\n' +
          'Players register a build, enter the match queue, and compete for standings on the leaderboard.\n\n' +
          'Click a button below to learn more — responses are only visible to you.'
        );

      const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('action_register')
          .setLabel('Register')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('queue_join')
          .setLabel('Join Queue')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('info_builds')
          .setLabel('Valid Builds')
          .setStyle(ButtonStyle.Secondary),
      );

      const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('info_report')
          .setLabel('Report Wins')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('info_commands')
          .setLabel('Commands')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('info_rules')
          .setLabel('Rules')
          .setStyle(ButtonStyle.Secondary),
      );

      const msg = await channel.send({ embeds: [embed], components: [row1, row2] });
      await cacheSet(
        CacheKeys.infoHubMsgId(),
        { channelId: channel.id, messageId: msg.id },
        INFO_HUB_TTL,
      );

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(EMBED_COLORS.success)
            .setTitle(`${CAIN_EMOJI} Info Hub Posted`)
            .setDescription(`Info hub posted to <#${channel.id}>.`),
        ],
      });
    } catch (err) {
      console.error('[/admin-post-info-hub]', err);
      await interaction.editReply({ content: 'Failed to post info hub. Check logs.' });
    }
  },
};
