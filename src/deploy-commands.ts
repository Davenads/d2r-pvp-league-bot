/**
 * deploy-commands.ts
 *
 * Registers slash commands with Discord.
 *
 * Usage:
 *   npm run deploy            → guild-scoped (instant, for dev)
 *   npm run deploy:global     → global (up to 1hr propagation, for prod)
 *
 * Guild-scoped requires DISCORD_GUILD_ID in .env.
 * Global does not — leave DISCORD_GUILD_ID blank.
 */

import { REST, Routes } from 'discord.js';
import { readdirSync } from 'fs';
import { join } from 'path';
import { config } from './config.js';
import type { Command } from './types/index.js';

const isGlobal = process.argv.includes('--global');

async function collectCommandData(): Promise<object[]> {
  const commandsPath = join(__dirname, 'commands');
  const data: object[] = [];

  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(join(dir, entry.name))
        : entry.name.endsWith('.ts') || entry.name.endsWith('.js')
        ? [join(dir, entry.name)]
        : []
    );
  }

  const files = walk(commandsPath);

  for (const file of files) {
    const module = await import(file) as { command?: Command };
    if (module.command) {
      data.push(module.command.data.toJSON());
    }
  }

  return data;
}

async function deploy(): Promise<void> {
  const commands = await collectCommandData();
  const rest = new REST().setToken(config.discord.token);

  if (isGlobal) {
    console.log(`[Deploy] Registering ${commands.length} command(s) globally...`);
    await rest.put(
      Routes.applicationCommands(config.discord.clientId),
      { body: commands }
    );
    console.log('[Deploy] Global commands registered. Allow up to 1 hour to propagate.');
  } else {
    if (!config.discord.guildId) {
      throw new Error('DISCORD_GUILD_ID is required for guild-scoped deployment. Set it in .env or use --global.');
    }
    console.log(`[Deploy] Registering ${commands.length} command(s) to guild ${config.discord.guildId}...`);
    await rest.put(
      Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId),
      { body: commands }
    );
    console.log('[Deploy] Guild commands registered. Changes are instant.');
  }
}

deploy().catch((err) => {
  console.error('[Deploy] Failed:', err);
  process.exit(1);
});
