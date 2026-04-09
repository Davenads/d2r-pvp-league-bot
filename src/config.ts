import 'dotenv/config';

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

/**
 * Resolve Google service account credentials (lazy — only called when Google services init).
 * Accepts either:
 *   - D2R_GOOGLE_KEY = full service account JSON blob (preferred for Heroku)
 *   - GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY as separate vars (fallback)
 */
export function resolveGoogleCredentials(): { serviceAccountEmail: string; privateKey: string } {
  const jsonBlob = process.env['D2R_GOOGLE_KEY'];
  if (jsonBlob) {
    const parsed = JSON.parse(jsonBlob) as { client_email: string; private_key: string };
    return {
      serviceAccountEmail: parsed.client_email,
      privateKey: parsed.private_key,
    };
  }
  return {
    serviceAccountEmail: requireEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
    privateKey: requireEnv('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n'),
  };
}

export const config = {
  discord: {
    token: requireEnv('DISCORD_TOKEN'),
    clientId: requireEnv('DISCORD_CLIENT_ID'),
    guildId: process.env['DISCORD_GUILD_ID'],  // undefined = global deployment
  },
  google: {
    sheetId: optionalEnv('GOOGLE_SHEET_ID', ''),  // empty string safe for deploy-commands.ts
  },
  redis: {
    url: optionalEnv('REDIS_URL', 'redis://localhost:6379'),
  },
  cache: {
    ttlRules: parseInt(optionalEnv('CACHE_TTL_RULES', '86400'), 10),
    ttlLadder: parseInt(optionalEnv('CACHE_TTL_LADDER', '300'), 10),
  },
  league: {
    warningThreshold: parseInt(optionalEnv('WARNING_THRESHOLD', '5'), 10),
    farmingCapMax: parseInt(optionalEnv('FARMING_CAP_MAX', '2'), 10),
    farmingCapHours: parseInt(optionalEnv('FARMING_CAP_HOURS', '24'), 10),
    matchCadenceDays: parseInt(optionalEnv('MATCH_CADENCE_DAYS', '3'), 10),
  },
  isDev: optionalEnv('NODE_ENV', 'development') === 'development',
} as const;
