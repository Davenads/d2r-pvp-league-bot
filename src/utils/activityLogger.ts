/**
 * Activity logger — posts a structured embed to #logs for every slash command
 * invocation and notable button click.
 *
 * All exports are fire-and-forget: callers use `void logActivity(...)` and are
 * never blocked. Errors are caught internally and written to console only.
 */

import { EmbedBuilder, Colors, ApplicationCommandOptionType } from 'discord.js';
import type { Client, TextChannel, CommandInteractionOption } from 'discord.js';
import { CHANNELS } from '../config/channels.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CommandLogEntry {
  type: 'command';
  commandName: string;
  user: { id: string; username: string; displayName: string };
  /** Serialized options string — use serializeOptions(interaction.options.data). */
  args: string;
  channelId: string;
  guildId: string | null;
  timestamp: Date;
}

export interface ButtonLogEntry {
  type: 'button';
  /** customId prefix (e.g. 'queue_join', 'report_win'). */
  action: string;
  /** Human-readable label for the embed title. */
  label: string;
  user: { id: string; username: string; displayName: string };
  /** Raw payload portion of the customId (everything after the first colon). */
  payload?: string;
  /** Optional resolved context string, e.g. 'Match #344'. */
  context?: string;
  channelId: string;
  guildId: string | null;
  timestamp: Date;
}

export type ActivityLogEntry = CommandLogEntry | ButtonLogEntry;

// ── Helpers ───────────────────────────────────────────────────────────────────

const FIELD_LIMIT = 900; // stay well under Discord's 1024-char field value limit

function truncate(s: string): string {
  return s.length > FIELD_LIMIT ? `${s.slice(0, FIELD_LIMIT)}…` : s;
}

/**
 * Serialize slash command options into a readable "name: value | name: value" string.
 * Handles subcommands and subcommand groups recursively.
 */
export function serializeOptions(options: readonly CommandInteractionOption[]): string {
  const parts: string[] = [];

  for (const opt of options) {
    if (
      opt.type === ApplicationCommandOptionType.Subcommand ||
      opt.type === ApplicationCommandOptionType.SubcommandGroup
    ) {
      parts.push(opt.name);
      if (opt.options?.length) {
        const inner = serializeOptions(opt.options);
        if (inner !== '(none)') parts.push(inner);
      }
    } else if (opt.value !== undefined) {
      parts.push(`${opt.name}: ${opt.value}`);
    }
  }

  return parts.length ? parts.join(' | ') : '(none)';
}

// ── Embed builder ─────────────────────────────────────────────────────────────

function buildLogEmbed(entry: ActivityLogEntry): EmbedBuilder {
  const userValue =
    `${entry.user.displayName} (@${entry.user.username})\nID: \`${entry.user.id}\``;
  const footerText = entry.guildId ? `Guild: ${entry.guildId}` : 'Direct Message';

  if (entry.type === 'command') {
    return new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle(`/${entry.commandName}`)
      .addFields(
        { name: 'User', value: userValue, inline: true },
        { name: 'Channel', value: `<#${entry.channelId}>`, inline: true },
        { name: 'Arguments', value: truncate(entry.args), inline: false },
      )
      .setFooter({ text: footerText })
      .setTimestamp(entry.timestamp);
  }

  // button
  const fields: { name: string; value: string; inline: boolean }[] = [
    { name: 'User', value: userValue, inline: true },
    { name: 'Channel', value: `<#${entry.channelId}>`, inline: true },
  ];

  if (entry.payload) {
    fields.push({ name: 'Payload', value: truncate(entry.payload), inline: true });
  }

  if (entry.context) {
    fields.push({ name: 'Context', value: truncate(entry.context), inline: false });
  }

  return new EmbedBuilder()
    .setColor(Colors.Purple)
    .setTitle(`Button: ${entry.label}`)
    .addFields(fields)
    .setFooter({ text: footerText })
    .setTimestamp(entry.timestamp);
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Fire-and-forget activity log. Call with `void logActivity(...)`.
 * Never throws and never blocks the caller.
 */
export function logActivity(client: Client, entry: ActivityLogEntry): void {
  void _post(client, entry).catch((err) => console.error('[activityLogger]', err));
}

async function _post(client: Client, entry: ActivityLogEntry): Promise<void> {
  const channel = client.channels.cache.get(CHANNELS.activityLog) as TextChannel | undefined;
  if (!channel) return;
  await channel.send({ embeds: [buildLogEmbed(entry)] });
}
