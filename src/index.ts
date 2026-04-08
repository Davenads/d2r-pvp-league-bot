import { Client, Collection, GatewayIntentBits } from 'discord.js';
import { readdirSync } from 'fs';
import { join } from 'path';
import { config } from './config.js';
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

main().catch((err) => {
  console.error('[Boot] Fatal error:', err);
  process.exit(1);
});
