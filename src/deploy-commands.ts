/**
 * deploy-commands.ts
 *
 * Registers slash commands with Discord.
 *
 * Usage:
 *   npm run deploy            → guild-scoped to all guilds in DISCORD_GUILD_IDS (instant)
 *   npm run deploy:global     → global (up to 1hr propagation)
 *
 * Guild-scoped requires DISCORD_GUILD_IDS (comma-separated) in .env.
 * DISCORD_GUILD_ID (single) is also accepted for backward compat.
 * Global does not require any guild ID.
 */

import { REST, Routes } from 'discord.js';
import { readdirSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
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
    const module = await import(pathToFileURL(file).href) as { command?: Command };
    if (module.command) {
      data.push(module.command.data.toJSON());
    }
  }

  return data;
}

function resolveGuildIds(): string[] {
  // Support comma-separated DISCORD_GUILD_IDS or fallback to single DISCORD_GUILD_ID
  const multi = process.env['DISCORD_GUILD_IDS'];
  if (multi) return multi.split(',').map((id) => id.trim()).filter(Boolean);
  if (config.discord.guildId) return [config.discord.guildId];
  return [];
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
    const guildIds = resolveGuildIds();
    if (guildIds.length === 0) {
      throw new Error('No guild IDs found. Set DISCORD_GUILD_IDS (comma-separated) or DISCORD_GUILD_ID in .env, or use --global.');
    }
    for (const guildId of guildIds) {
      console.log(`[Deploy] Registering ${commands.length} command(s) to guild ${guildId}...`);
      await rest.put(
        Routes.applicationGuildCommands(config.discord.clientId, guildId),
        { body: commands }
      );
      console.log(`[Deploy] Guild ${guildId} done.`);
    }
    console.log('[Deploy] All guild commands registered. Changes are instant.');
  }
}

deploy().catch((err) => {
  console.error('[Deploy] Failed:', err);
  process.exit(1);
});
