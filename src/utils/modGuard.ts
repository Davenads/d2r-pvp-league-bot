import type { ChatInputCommandInteraction } from 'discord.js';
import { GuildMemberRoleManager } from 'discord.js';

const MOD_ROLE_NAME = '1v1 Moderator';

/**
 * Returns true if the invoking member has the '1v1 Moderator' role.
 * Must be called inside a guild command — always false in DMs.
 */
export function hasModRole(interaction: ChatInputCommandInteraction): boolean {
  const { member } = interaction;
  if (!member) return false;
  // In a cached guild context, roles is a GuildMemberRoleManager.
  // In a non-cached (REST-only) context, roles is string[] of role IDs — cannot check by name.
  if (!(member.roles instanceof GuildMemberRoleManager)) return false;
  return member.roles.cache.some((role) => role.name === MOD_ROLE_NAME);
}

/**
 * Checks for the mod role and replies with an ephemeral error if missing.
 * Returns true if the check passed (caller should proceed), false if denied (caller should return).
 *
 * Usage:
 *   if (!await assertModRole(interaction)) return;
 */
export async function assertModRole(interaction: ChatInputCommandInteraction): Promise<boolean> {
  if (hasModRole(interaction)) return true;
  await interaction.editReply({
    embeds: [
      {
        color: 0xed4245, // red
        description: `❌ This command requires the **${MOD_ROLE_NAME}** role.`,
      },
    ],
  });
  return false;
}
