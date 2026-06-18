import { EmbedBuilder, Colors } from 'discord.js';
import type { Client } from 'discord.js';
import { getForcedMatchThread, clearForcedMatchThread } from '../services/queue.js';

/**
 * Closes a player's forced-assignment notification thread, if one is tracked.
 *
 * Posts a short closing note, then locks + archives the thread in a single
 * atomic edit (locking prevents Discord from auto-unarchiving on a later post).
 * The Redis tracking key is always cleared, even if the thread is gone.
 *
 * Robust to cache misses: falls back to client.channels.fetch when the thread
 * isn't in the local cache (the previous inline implementation only checked the
 * cache and silently skipped archiving on a miss, which left threads open).
 *
 * Safe to call when no thread exists — it no-ops. Never throws.
 */
export async function archiveForcedThread(
  client: Client,
  discordId: string,
  closingNote: string,
): Promise<void> {
  const threadId = await getForcedMatchThread(discordId);
  if (!threadId) return;

  // Clear the tracking key first so concurrent callers don't double-process.
  await clearForcedMatchThread(discordId);

  try {
    const thread =
      client.channels.cache.get(threadId) ??
      (await client.channels.fetch(threadId).catch(() => null));

    if (thread?.isThread() && !thread.archived) {
      await thread
        .send({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Green)
              .setDescription(closingNote)
              .setTimestamp(),
          ],
        })
        .catch(() => null);

      await thread.edit({ locked: true, archived: true }).catch(() => null);
    }
  } catch {
    // Non-critical — thread may already be archived or deleted.
  }
}
