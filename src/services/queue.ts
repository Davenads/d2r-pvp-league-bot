/**
 * Queue service — manages FIFO match queue and active match state in Redis.
 *
 * Queue key:   d2r:queue                       Redis list (RPUSH to enqueue, LPOP to dequeue)
 * State key:   d2r:player:{discordId}:state    "idle" | "queued" | "in_match"
 * Match key:   d2r:match:active:{discordId}    ActiveMatchState JSON (set for both players)
 * Farming key: d2r:farming:{sortedPair}        Counter with TTL
 */

import { prisma } from '../db/client.js';
import { getRedisClient } from './cache.js';
import { isMatchupBanned } from './matchup.js';
import { CacheKeys, type PlayerQueueState, type ActiveMatchState } from '../types/index.js';
import { config } from '../config.js';

// ── Player state ──────────────────────────────────────────────────────────────

export async function getPlayerState(discordId: string): Promise<PlayerQueueState> {
  const redis = getRedisClient();
  const raw = await redis.get(CacheKeys.playerState(discordId));
  if (raw === 'queued' || raw === 'in_match') return raw;
  return 'idle';
}

export async function setPlayerState(discordId: string, state: PlayerQueueState): Promise<void> {
  const redis = getRedisClient();
  if (state === 'idle') {
    await redis.del(CacheKeys.playerState(discordId));
  } else {
    await redis.set(CacheKeys.playerState(discordId), state);
  }
}

// ── Active match state ────────────────────────────────────────────────────────

export async function getActiveMatch(discordId: string): Promise<ActiveMatchState | null> {
  const redis = getRedisClient();
  const raw = await redis.get(CacheKeys.activeMatch(discordId));
  if (!raw) return null;
  return JSON.parse(raw) as ActiveMatchState;
}

export async function setActiveMatch(matchState: ActiveMatchState): Promise<void> {
  const redis = getRedisClient();
  const json = JSON.stringify(matchState);
  await redis.set(CacheKeys.activeMatch(matchState.player1DiscordId), json);
  await redis.set(CacheKeys.activeMatch(matchState.player2DiscordId), json);
}

/** Update the threadId on an already-active match (called after thread creation). */
export async function setMatchThreadId(discordId: string, threadId: string): Promise<void> {
  const match = await getActiveMatch(discordId);
  if (!match) return;
  const updated: ActiveMatchState = { ...match, threadId };
  await setActiveMatch(updated);
}

export async function clearActiveMatch(discordId: string): Promise<void> {
  const match = await getActiveMatch(discordId);
  if (!match) return;
  const redis = getRedisClient();
  await redis.del(
    CacheKeys.activeMatch(match.player1DiscordId),
    CacheKeys.activeMatch(match.player2DiscordId),
  );
}

// ── Farming cap ───────────────────────────────────────────────────────────────

/**
 * Returns true if the two players have hit the farming cap within the window.
 */
export async function isFarmingCapped(p1: string, p2: string): Promise<boolean> {
  const redis = getRedisClient();
  const key = CacheKeys.farmingPair(p1, p2);
  const raw = await redis.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  return count >= config.league.farmingCapMax;
}

/**
 * Records a pairing. Increments the counter and (re)sets the TTL window.
 */
export async function recordPairing(p1: string, p2: string): Promise<void> {
  const redis = getRedisClient();
  const key = CacheKeys.farmingPair(p1, p2);
  const ttlSeconds = config.league.farmingCapHours * 3600;
  const exists = await redis.exists(key);
  if (exists) {
    await redis.incr(key);
  } else {
    await redis.set(key, '1', 'EX', ttlSeconds);
  }
}

// ── FIFO queue ────────────────────────────────────────────────────────────────

/** Returns full queue as ordered array of Discord IDs (oldest first). */
export async function getQueueList(): Promise<string[]> {
  const redis = getRedisClient();
  return redis.lrange(CacheKeys.queue(), 0, -1);
}

/** Returns 1-based queue position, or 0 if not in queue. */
export async function getQueuePosition(discordId: string): Promise<number> {
  const queue = await getQueueList();
  const idx = queue.indexOf(discordId);
  return idx === -1 ? 0 : idx + 1;
}

/** Removes a player from the queue. Returns true if they were removed. */
export async function leaveQueue(discordId: string): Promise<boolean> {
  const redis = getRedisClient();
  const removed = await redis.lrem(CacheKeys.queue(), 0, discordId);
  if (removed > 0) {
    await setPlayerState(discordId, 'idle');
    return true;
  }
  return false;
}

// ── Join queue / match trigger ────────────────────────────────────────────────

export interface JoinQueueResult {
  matched: false;
  position: number;
}

export interface MatchResult {
  matched: true;
  matchId: number;
  opponentDiscordId: string;
  yourBuild: string;
  opponentBuild: string;
}

export type QueueJoinOutcome = JoinQueueResult | MatchResult;

/**
 * Attempt to join the queue.
 *
 * If another player is already waiting, match them immediately (FIFO).
 * Checks farming cap before matching — if capped, the joining player
 * is placed in queue instead.
 *
 * Returns either a "queued" result with position, or a "matched" result
 * with full match details for the command to use when creating the thread.
 */
export async function joinQueue(joinerDiscordId: string): Promise<QueueJoinOutcome> {
  const redis = getRedisClient();
  const queueKey = CacheKeys.queue();

  // Peek at the front of the queue without removing
  const queueList = await redis.lrange(queueKey, 0, -1);

  // Try to find a valid (non-farming-capped) opponent from the front of queue
  for (const candidateId of queueList) {
    const capped = await isFarmingCapped(joinerDiscordId, candidateId);
    if (capped) continue;

    // Found a valid opponent — remove them from queue
    await redis.lrem(queueKey, 1, candidateId);

    // Look up both players in the active season
    const season = await prisma.season.findFirst({ where: { active: true } });
    if (!season) {
      // No active season — put candidate back and queue the joiner
      await redis.lpush(queueKey, candidateId);
      break;
    }

    const [joinerPlayer, opponentPlayer] = await Promise.all([
      prisma.player.findFirst({ where: { discordId: joinerDiscordId, seasonId: season.id, status: 'ACTIVE' } }),
      prisma.player.findFirst({ where: { discordId: candidateId, seasonId: season.id, status: 'ACTIVE' } }),
    ]);

    if (!joinerPlayer || !opponentPlayer) {
      // One of the players is invalid — put candidate back and queue the joiner
      await redis.lpush(queueKey, candidateId);
      break;
    }

    // Select builds for the match
    const { build1, build2 } = await selectBuilds(joinerPlayer, opponentPlayer);

    // Create Postgres Match record
    const match = await prisma.match.create({
      data: {
        seasonId: season.id,
        player1Id: joinerPlayer.id,
        player2Id: opponentPlayer.id,
        build1Used: build1,
        build2Used: build2,
        type: 'STANDARD',
        status: 'PENDING',
      },
    });

    // Set Redis state for both players
    const matchState: ActiveMatchState = {
      matchId: match.id,
      player1DiscordId: joinerDiscordId,
      player2DiscordId: candidateId,
      build1,
      build2,
      createdAt: Date.now(),
    };

    await Promise.all([
      setActiveMatch(matchState),
      setPlayerState(joinerDiscordId, 'in_match'),
      setPlayerState(candidateId, 'in_match'),
      recordPairing(joinerDiscordId, candidateId),
    ]);

    return {
      matched: true,
      matchId: match.id,
      opponentDiscordId: candidateId,
      yourBuild: build1,
      opponentBuild: build2,
    };
  }

  // No valid opponent — join the queue
  await redis.rpush(queueKey, joinerDiscordId);
  await setPlayerState(joinerDiscordId, 'queued');
  const position = await redis.llen(queueKey);

  return { matched: false, position };
}

// ── Build selection ───────────────────────────────────────────────────────────

/**
 * Selects the builds to use for a match between two players.
 *
 * Current strategy: prefer the first non-banned pairing from all 4 combinations.
 * Falls back to build1 vs build1 if all are banned (shouldn't happen in practice).
 *
 * TODO: Replace with "least-disadvantaged matchup" algorithm once Stadium
 *       defines the scoring criteria (matchup-matrix-based scoring TBD).
 */
async function selectBuilds(
  p1: { build1: string; build2: string },
  p2: { build1: string; build2: string },
): Promise<{ build1: string; build2: string }> {
  const pairs: Array<[string, string]> = [
    [p1.build1, p2.build1],
    [p1.build1, p2.build2],
    [p1.build2, p2.build1],
    [p1.build2, p2.build2],
  ];

  for (const [b1, b2] of pairs) {
    const banned = await isMatchupBanned(b1, b2);
    if (!banned) return { build1: b1, build2: b2 };
  }

  // All combos banned — return default (edge case)
  return { build1: p1.build1, build2: p2.build1 };
}
