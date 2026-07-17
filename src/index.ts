import { Client, Collection, GatewayIntentBits } from 'discord.js';
import { readdirSync } from 'fs';
import { join } from 'path';
import { config } from './config.js';
import { prisma } from './db/client.js';
import { closeCache } from './services/cache.js';
import type { Command } from './types/index.js';

// ── Extended client type ─────────────────────────────────────────────────────

export interface BotClient extends Client {
  commands: Collection<string, Command>;
}

// ── Create client ────────────────────────────────────────────────────────────

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
}) as BotClient;

client.commands = new Collection();

// ── Load commands ────────────────────────────────────────────────────────────

async function loadCommands(): Promise<void> {
  const commandsPath = join(__dirname, 'commands');

  // Walk top-level command files and subdirectories (e.g. admin/)
  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(join(dir, entry.name))
        : entry.name.endsWith('.js')
        ? [join(dir, entry.name)]
        : []
    );
  }

  const files = walk(commandsPath);

  for (const file of files) {
    const module = await import(file) as { command?: Command };
    if (!module.command) {
      console.warn(`[Commands] ${file} has no exported 'command'. Skipping.`);
      continue;
    }
    client.commands.set(module.command.data.name, module.command);
    console.log(`[Commands] Loaded /${module.command.data.name}`);
  }
}

// ── Load events ──────────────────────────────────────────────────────────────

async function loadEvents(): Promise<void> {
  const eventsPath = join(__dirname, 'events');
  const files = readdirSync(eventsPath).filter((f) => f.endsWith('.js') && !f.endsWith('.d.ts'));

  for (const file of files) {
    const module = await import(join(eventsPath, file)) as {
      name: string;
      once: boolean;
      execute: (...args: unknown[]) => Promise<void>;
    };

    if (module.once) {
      client.once(module.name, (...args) => module.execute(...args));
    } else {
      client.on(module.name, (...args) => module.execute(...args));
    }

    console.log(`[Events] Registered event: ${module.name}`);
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await loadCommands();
  await loadEvents();
  await client.login(config.discord.token);
}

// ── Process-level safety nets ────────────────────────────────────────────────

let shuttingDown = false;

/**
 * Gracefully tears down external connections before the process exits.
 * Heroku sends SIGTERM (then SIGKILL ~30s later) on every dyno cycle/redeploy;
 * without this the gateway session lingers and in-flight Redis / Postgres /
 * Sheets work can be cut mid-operation.
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Shutdown] Received ${signal} — cleaning up...`);

  // Hard ceiling so a hung dependency can't eat the whole SIGKILL grace window.
  const forceExit = setTimeout(() => {
    console.error('[Shutdown] Cleanup timed out — forcing exit.');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  try {
    client.destroy();
    console.log('[Shutdown] Discord client destroyed.');
  } catch (err) {
    console.error('[Shutdown] client.destroy failed:', err);
  }

  try {
    await prisma.$disconnect();
    console.log('[Shutdown] Prisma disconnected.');
  } catch (err) {
    console.error('[Shutdown] prisma.$disconnect failed:', err);
  }

  try {
    await closeCache();
    console.log('[Shutdown] Redis connection closed.');
  } catch (err) {
    console.error('[Shutdown] closeCache failed:', err);
  }

  clearTimeout(forceExit);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// Log stray rejections/exceptions instead of letting them crash the process.
// The most common source is a nested throw inside an interaction catch block
// (e.g. editReply after a failed defer). Keeping the process alive preserves
// the gateway connection and all in-flight matches.
process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught exception:', err);
});

// ── Boot ─────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error('[Boot] Fatal error:', err);
  process.exit(1);
});
