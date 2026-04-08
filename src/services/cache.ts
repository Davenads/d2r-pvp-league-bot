import Redis from 'ioredis';
import { config } from '../config.js';

let client: Redis | null = null;

function getClient(): Redis {
  if (!client) {
    client = new Redis(config.redis.url, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });

    client.on('error', (err) => {
      console.error('[Redis] Connection error:', err.message);
    });

    client.on('connect', () => {
      console.log('[Redis] Connected');
    });
  }
  return client;
}

/**
 * Get a cached value. Returns null on cache miss or Redis failure.
 * Never throws — Redis failure falls back to a live sheet fetch.
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const raw = await getClient().get(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Set a cache value with a TTL in seconds.
 * Never throws — Redis failure is non-fatal.
 */
export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  try {
    await getClient().set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (err) {
    console.warn('[Redis] Failed to set cache key:', key, err);
  }
}

/**
 * Delete one or more cache keys (e.g. on forced refresh).
 */
export async function cacheDel(...keys: string[]): Promise<void> {
  try {
    if (keys.length > 0) await getClient().del(...keys);
  } catch (err) {
    console.warn('[Redis] Failed to delete cache keys:', keys, err);
  }
}

/**
 * Delete all keys matching a pattern (e.g. 'd2r:matchup:*').
 * Uses SCAN to avoid blocking Redis on large keyspaces.
 */
export async function cacheFlushPattern(pattern: string): Promise<number> {
  const redis = getClient();
  let cursor = '0';
  let deleted = 0;

  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = nextCursor;
    if (keys.length > 0) {
      await redis.del(...keys);
      deleted += keys.length;
    }
  } while (cursor !== '0');

  return deleted;
}

/**
 * Exposes the raw ioredis client for operations not covered by the helper
 * functions above (e.g. list operations for the queue).
 */
export function getRedisClient(): Redis {
  return getClient();
}

export async function closeCache(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}
