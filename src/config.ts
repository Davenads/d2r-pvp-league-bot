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
 * Resolve Google service account credentials.
 * Accepts either:
 *   - D2R_GOOGLE_KEY = full service account JSON blob (preferred for Heroku)
 *   - GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY as separate vars (fallback)
 */
function resolveGoogleCredentials(): { serviceAccountEmail: string; privateKey: string } {
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

const googleCredentials = resolveGoogleCredentials();

export const config = {
  discord: {
    token: requireEnv('DISCORD_TOKEN'),
    clientId: requireEnv('DISCORD_CLIENT_ID'),
    guildId: process.env['DISCORD_GUILD_ID'],  // undefined = global deployment
  },
  google: {
    sheetId: requireEnv('GOOGLE_SHEET_ID'),
    serviceAccountEmail: googleCredentials.serviceAccountEmail,
    privateKey: googleCredentials.privateKey,
  },
  redis: {
    url: optionalEnv('REDIS_URL', 'redis://localhost:6379'),
  },
  cache: {
    ttlRules: parseInt(optionalEnv('CACHE_TTL_RULES', '3600'), 10),
    ttlLadder: parseInt(optionalEnv('CACHE_TTL_LADDER', '60'), 10),
  },
  isDev: optionalEnv('NODE_ENV', 'development') === 'development',
} as const;
