import { Client, Events } from 'discord.js';
import { startScheduler } from '../services/scheduler.js';
import { updateLeaderboardEmbed } from '../services/leaderboardEmbed.js';
import { ensureQueueButtonExists } from '../services/queueButton.js';

export const name = Events.ClientReady;
export const once = true;

export async function execute(client: Client<true>): Promise<void> {
  console.log(`[Bot] Logged in as ${client.user.tag}`);
  startScheduler(client);

  updateLeaderboardEmbed(client).catch((e) =>
    console.error('[ready] Leaderboard embed startup refresh failed:', e)
  );

  ensureQueueButtonExists(client).catch((e) =>
    console.error('[ready] Queue button startup check failed:', e)
  );
}
