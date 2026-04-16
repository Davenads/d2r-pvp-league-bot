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
import { getDeathmatches } from './content.js';
import {
  CacheKeys,
  type PlayerQueueState,
  type ActiveMatchState,
  type MirrorRequest,
  type BuildPairing,
  type MatchFound,
} from '../types/index.js';
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

// ── Build combination helpers ─────────────────────────────────────────────────

type PlayerBuildsArg = {
  build1: string;
  build2: string;
  build3: string | null;
  build4: string | null;
  build5: string | null;
};

/** Returns all non-null registered builds for a player as an ordered array. */
function getPlayerBuilds(p: PlayerBuildsArg): string[] {
  return [p.build1, p.build2, p.build3, p.build4, p.build5].filter((b): b is string => !!b);
}

/**
 * Returns all NxM build pairings between two players.
 * Each non-banned pairing is tagged STANDARD or DEATHMATCH based on the deathmatches sheet.
 * If EITHER build lists the other as a deathmatch opponent, the pairing is DEATHMATCH.
 */
export async function getAllowedMatchups(
  p1: PlayerBuildsArg,
  p2: PlayerBuildsArg,
): Promise<{ available: BuildPairing[]; all: BuildPairing[]; allBanned: boolean }> {
  const p1Builds = getPlayerBuilds(p1);
  const p2Builds = getPlayerBuilds(p2);
  const deathmatches = await getDeathmatches();
  const all: BuildPairing[] = [];
  const available: BuildPairing[] = [];

  for (const b1 of p1Builds) {
    for (const b2 of p2Builds) {
      const banned = await isMatchupBanned(b1, b2);
      const pairingType = isPairingDeathmatch(b1, b2, deathmatches) ? 'DEATHMATCH' : 'STANDARD';
      const pairing: BuildPairing = { build1: b1, build2: b2, type: pairingType };
      all.push(pairing);
      if (!banned) available.push(pairing);
    }
  }

  return { available, all, allBanned: available.length === 0 };
}

/**
 * Returns true if either build lists the other as a deathmatch opponent.
 */
function isPairingDeathmatch(b1: string, b2: string, deathmatches: Map<string, string[]>): boolean {
  const b1Dms = deathmatches.get(b1) ?? [];
  const b2Dms = deathmatches.get(b2) ?? [];
  return b1Dms.includes(b2) || b2Dms.includes(b1);
}

/**
 * Randomly picks one element from the provided pairings array.
 * Caller must ensure the array is non-empty.
 */
export function selectRandomPairing(pairings: BuildPairing[]): BuildPairing {
  const idx = Math.floor(Math.random() * pairings.length);
  return pairings[idx];
}

// ── Join queue / match trigger ────────────────────────────────────────────────

export interface JoinQueueResult {
  matched: false;
  position: number;
}

export type QueueJoinOutcome = JoinQueueResult | MatchFound;

/**
 * Attempt to join the queue.
 *
 * If another player is already waiting, match them immediately (FIFO).
 * Checks farming cap before matching — if capped, the joining player
 * is placed in queue instead.
 *
 * If valid pairings exist, the bot randomly selects one and creates the
 * Prisma Match record immediately. Returns MatchFound with selectedMatchup.
 *
 * If all pairings are banned, returns MatchFound with allBanned: true
 * and no matchId — the override flow in the command handler creates the record.
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

    // Compute all allowed matchup combinations with deathmatch tagging
    const { available, allBanned } = await getAllowedMatchups(joinerPlayer, opponentPlayer);

    // Set both players to in_match and record pairing regardless of allBanned
    await Promise.all([
      setPlayerState(joinerDiscordId, 'in_match'),
      setPlayerState(candidateId, 'in_match'),
      recordPairing(joinerDiscordId, candidateId),
    ]);

    if (allBanned) {
      // All pairings banned — return without creating a Match record.
      // The override button handler will create it after mod/player override.
      return {
        matched: true,
        opponentDiscordId: candidateId,
        matchId: 0,  // sentinel — no record created yet
        selectedMatchup: { build1: joinerPlayer.build1, build2: opponentPlayer.build1 },
        matchType: 'STANDARD',
        allBanned: true,
      };
    }

    // Randomly select a pairing
    const selected = selectRandomPairing(available);

    // Create Prisma Match record immediately
    const match = await prisma.match.create({
      data: {
        seasonId: season.id,
        player1Id: joinerPlayer.id,
        player2Id: opponentPlayer.id,
        build1Used: selected.build1,
        build2Used: selected.build2,
        type: 'STANDARD',
        status: 'PENDING',
      },
    });

    // Set ActiveMatchState in Redis
    const matchState: ActiveMatchState = {
      matchId: match.id,
      player1DiscordId: joinerDiscordId,
      player2DiscordId: candidateId,
      build1: selected.build1,
      build2: selected.build2,
      createdAt: Date.now(),
    };
    await setActiveMatch(matchState);

    return {
      matched: true,
      opponentDiscordId: candidateId,
      matchId: match.id,
      selectedMatchup: { build1: selected.build1, build2: selected.build2 },
      matchType: selected.type === 'DEATHMATCH' ? 'DEATHMATCH' : 'STANDARD',
      allBanned: false,
    };
  }

  // No valid opponent — join the queue
  await redis.rpush(queueKey, joinerDiscordId);
  await setPlayerState(joinerDiscordId, 'queued');
  const position = await redis.llen(queueKey);

  return { matched: false, position };
}

/**
 * Re-queues both players after an all-banned override was declined.
 * Sets their state back to 'queued' and appends them to the queue list.
 */
export async function reQueueBothPlayers(p1Id: string, p2Id: string): Promise<void> {
  const redis = getRedisClient();
  const queueKey = CacheKeys.queue();
  await Promise.all([
    setPlayerState(p1Id, 'queued'),
    setPlayerState(p2Id, 'queued'),
  ]);
  // Append both to the back of the queue
  await redis.rpush(queueKey, p1Id);
  await redis.rpush(queueKey, p2Id);
}

// ── Forced match assignment ───────────────────────────────────────────────────

export interface ForcedMatchAssignment {
  assignedAt: number;  // unix ms — used by scheduler to detect unacknowledged assignments
}

/**
 * Sets a pending forced match assignment for a player.
 * Called by the scheduler when a player is overdue.
 * TTL: 48h — if they don't acknowledge, the scheduler will escalate.
 */
export async function setForcedMatch(discordId: string, assignment: ForcedMatchAssignment): Promise<void> {
  const redis = getRedisClient();
  await redis.set(CacheKeys.forcedMatch(discordId), JSON.stringify(assignment), 'EX', 172800);
}

/** Returns the pending forced match assignment, or null if none. */
export async function getForcedMatch(discordId: string): Promise<ForcedMatchAssignment | null> {
  const redis = getRedisClient();
  const raw = await redis.get(CacheKeys.forcedMatch(discordId));
  if (!raw) return null;
  return JSON.parse(raw) as ForcedMatchAssignment;
}

/** Clears a forced match assignment (called by /im-ready). */
export async function clearForcedMatch(discordId: string): Promise<void> {
  const redis = getRedisClient();
  await redis.del(CacheKeys.forcedMatch(discordId));
}

// ── Mirror request storage ────────────────────────────────────────────────────

const MIRROR_REQUEST_TTL = 300; // 5 minutes

/** Stores a pending mirror request. Returns the nonce key for button IDs. */
export async function createMirrorRequest(req: MirrorRequest): Promise<string> {
  const redis = getRedisClient();
  const nonce = `${req.requesterId}_${Date.now()}`;
  const key = CacheKeys.mirrorRequest(nonce);
  await redis.set(key, JSON.stringify(req), 'EX', MIRROR_REQUEST_TTL);
  return nonce;
}

/** Retrieves a pending mirror request by nonce. Returns null if expired or not found. */
export async function getMirrorRequest(nonce: string): Promise<MirrorRequest | null> {
  const redis = getRedisClient();
  const raw = await redis.get(CacheKeys.mirrorRequest(nonce));
  if (!raw) return null;
  return JSON.parse(raw) as MirrorRequest;
}

/** Deletes a mirror request (used on accept or decline). */
export async function deleteMirrorRequest(nonce: string): Promise<void> {
  const redis = getRedisClient();
  await redis.del(CacheKeys.mirrorRequest(nonce));
}

/**
 * Scans Redis for a pending mirror request where the given Discord ID is the opponent.
 * Returns the nonce and request data, or null if none found.
 * Used by /admin-accept-mirror to bypass the button click requirement.
 */
export async function findMirrorRequestByOpponent(
  opponentId: string,
): Promise<{ nonce: string; req: MirrorRequest } | null> {
  const redis = getRedisClient();
  const prefix = CacheKeys.mirrorRequest('');
  const keys = await redis.keys(`${prefix}*`);
  if (keys.length === 0) return null;
  const values = await redis.mget(...keys);
  for (let i = 0; i < keys.length; i++) {
    const raw = values[i];
    if (!raw) continue;
    const req = JSON.parse(raw) as MirrorRequest;
    if (req.opponentId === opponentId) {
      return { nonce: keys[i].slice(prefix.length), req };
    }
  }
  return null;
}

/**
 * Creates a mirror match in Postgres and sets Redis state for both players.
 * Farming cap is intentionally skipped — mutual consent implies awareness.
 */
export async function startMirrorMatch(
  req: MirrorRequest,
  seasonId: number,
  p1DbId: number,
  p2DbId: number,
): Promise<{ matchId: number }> {
  const match = await prisma.match.create({
    data: {
      seasonId,
      player1Id: p1DbId,
      player2Id: p2DbId,
      build1Used: req.build,
      build2Used: req.build,
      type: 'STANDARD',
      status: 'PENDING',
    },
  });

  const matchState: ActiveMatchState = {
    matchId: match.id,
    player1DiscordId: req.requesterId,
    player2DiscordId: req.opponentId,
    build1: req.build,
    build2: req.build,
    createdAt: Date.now(),
  };

  await Promise.all([
    setActiveMatch(matchState),
    setPlayerState(req.requesterId, 'in_match'),
    setPlayerState(req.opponentId, 'in_match'),
  ]);

  return { matchId: match.id };
}
