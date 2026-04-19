import type { Client } from 'discord.js';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, TextChannel } from 'discord.js';
import { cacheGet, cacheSet } from './cache.js';
import { CacheKeys } from '../types/index.js';
import { CHANNELS } from '../config/channels.js';
import { EMBED_COLORS, CAIN_EMOJI } from '../utils/formatters.js';

const BTN_MSG_TTL = 30 * 24 * 60 * 60; // 30 days

function buildQueueButtonEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(EMBED_COLORS.rules)
    .setTitle(`${CAIN_EMOJI} D2R 1v1 League — Join the Queue`)
    .setDescription(
      'Click the button below to enter the match queue.\n\n' +
      'You will be matched with the next available opponent (FIFO). ' +
      'Your queue position is private — only mods can see the full queue order.\n\n' +
      'You must be **registered** to queue. Use `/register` if you haven\'t signed up yet.'
    )
    .setFooter({ text: 'Replies are visible only to you.' });
}

function buildQueueButtonRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('queue_join')
      .setLabel('⚔️ Join Queue')
      .setStyle(ButtonStyle.Primary)
  );
}

/**
 * Ensures the persistent queue button embed exists in the leaderboard channel.
 * Called on bot startup. Recovers across restarts via Redis message ID.
 */
export async function ensureQueueButtonExists(client: Client): Promise<void> {
  try {
    const channel = client.channels.cache.get(CHANNELS.leaderboard) as TextChannel | undefined;
    if (!channel) {
      console.warn('[QueueButton] Leaderboard channel not in cache:', CHANNELS.leaderboard);
      return;
    }

    const embed = buildQueueButtonEmbed();
    const row = buildQueueButtonRow();

    // Try to edit the existing message if we have it stored
    const storedMsgId = await cacheGet<string>(CacheKeys.queueBtnMsgId());
    if (storedMsgId) {
      try {
        const existing = await channel.messages.fetch(storedMsgId);
        await existing.edit({ embeds: [embed], components: [row] });
        console.log('[QueueButton] Button embed refreshed (msg:', storedMsgId, ')');
        return;
      } catch {
        console.warn('[QueueButton] Stored message not found, will post a new one.');
      }
    }

    // Scan recent messages for an existing queue button embed (Redis key loss recovery)
    const botId = client.user?.id;
    if (botId) {
      try {
        const recent = await channel.messages.fetch({ limit: 20 });
        const found = recent.find(
          (m) =>
            m.author.id === botId &&
            m.embeds.some((e) => e.title?.includes('Join the Queue'))
        );
        if (found) {
          await found.edit({ embeds: [embed], components: [row] });
          await cacheSet(CacheKeys.queueBtnMsgId(), found.id, BTN_MSG_TTL);
          console.log('[QueueButton] Recovered existing embed via scan (msg:', found.id, ')');
          return;
        }
      } catch (scanErr) {
        console.warn('[QueueButton] Channel scan failed:', scanErr);
      }
    }

    // Post a fresh button embed
    const msg = await channel.send({ embeds: [embed], components: [row] });
    await cacheSet(CacheKeys.queueBtnMsgId(), msg.id, BTN_MSG_TTL);
    console.log('[QueueButton] New button embed posted (msg:', msg.id, ')');
  } catch (err) {
    console.error('[QueueButton] Failed to ensure button exists:', err);
  }
}
