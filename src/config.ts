import 'dotenv/config';

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const config = {
  discord: {
    token: requireEnv('DISCORD_TOKEN'),
    clientId: requireEnv('DISCORD_CLIENT_ID'),
    guildId: process.env['DISCORD_GUILD_ID'],  // undefined = global deployment
  },
  google: {
    sheetId: requireEnv('GOOGLE_SHEET_ID'),
    serviceAccountEmail: requireEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
    // Replaces literal \n in env var with actual newlines (common .env gotcha)
    privateKey: requireEnv('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n'),
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
