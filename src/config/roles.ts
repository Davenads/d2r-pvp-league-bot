// Discord role IDs for the D2R 1v1 League server.
// These are non-sensitive snowflake IDs — safe to commit.

export const ROLES = {
  mod: '1491085681777447072', // 1v1 Moderator
} as const;

export type RoleKey = keyof typeof ROLES;
