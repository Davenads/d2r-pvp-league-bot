/**
 * Match extension service — handles the mutual-consent extend flow.
 *
 * Either player can initiate an extension request. The other player must
 * click "Accept" to confirm. Only ONE extension is allowed per match.
 * On acceptance, ready check counts reset and the match deadline shifts +3 days.
 *
 * Redis keys (TTL 8 days for sentinel; 48h for pending requests):
 *   d2r:match:extend:req:{matchId}  → JSON ExtendRequest (48h TTL)
 *   d2r:match:extended:{matchId}    → "true" (8-day sentinel — one-extension-only)
 */

import { getRedisClient } from './cache.js';
import { CacheKeys } from '../types/index.js';
import { prisma } from '../db/client.js';
import { resetReadyChecks } from './readyCheck.js';

const EXTEND_REQ_TTL  = 48 * 60 * 60;   // 48 hours — pending request window
const EXTEND_FLAG_TTL =  8 * 24 * 60 * 60; // 8 days — one-extension sentinel

interface ExtendRequest {
  requesterId: string;    // Discord ID of the player who initiated
  requestedAt: number;   // unix ms
}

export type ExtendRequestResult =
  | { status: 'already_extended' }
  | { status: 'request_pending'; existingRequesterId: string }
  | { status: 'ok' };

export type ExtendAcceptResult =
  | { status: 'no_request' }
  | { status: 'wrong_player' }
  | { status: 'ok' };

// ── Initiation ────────────────────────────────────────────────────────────────

/**
 * Creates a pending extension request for a match.
 *
 * Returns:
 *   { status: 'already_extended' }          — match already used its one extension
 *   { status: 'request_pending', ... }       — a request is already waiting for this match
 *   { status: 'ok' }                         — request stored; caller should ping opponent
 */
export async function requestExtension(
  matchId: number,
  requesterId: string,
): Promise<ExtendRequestResult> {
  const redis = getRedisClient();

  // One-extension-only gate
  const alreadyExtended = await redis.exists(CacheKeys.matchExtended(matchId));
  if (alreadyExtended) {
    return { status: 'already_extended' };
  }

  // Check for an existing pending request
  const existingRaw = await redis.get(CacheKeys.matchExtendReq(matchId));
  if (existingRaw) {
    const existing = JSON.parse(existingRaw) as ExtendRequest;
    return { status: 'request_pending', existingRequesterId: existing.requesterId };
  }

  const req: ExtendRequest = { requesterId, requestedAt: Date.now() };
  await redis.set(CacheKeys.matchExtendReq(matchId), JSON.stringify(req), 'EX', EXTEND_REQ_TTL);

  return { status: 'ok' };
}

// ── Acceptance ────────────────────────────────────────────────────────────────

/**
 * Accepts a pending extension request.
 *
 * Validates that the acceptor is NOT the requester (can't self-accept).
 * On success: resets RC counts, sets extendedAt in Prisma, sets the
 * one-extension sentinel in Redis, and removes the pending request.
 *
 * Returns:
 *   { status: 'no_request' }   — no pending request found (expired or never created)
 *   { status: 'wrong_player' } — acceptor is the same as the requester
 *   { status: 'ok' }           — extension granted
 */
export async function acceptExtension(
  matchId: number,
  acceptorId: string,
  p1DiscordId: string,
  p2DiscordId: string,
): Promise<ExtendAcceptResult> {
  const redis = getRedisClient();

  const reqRaw = await redis.get(CacheKeys.matchExtendReq(matchId));
  if (!reqRaw) {
    return { status: 'no_request' };
  }

  const req = JSON.parse(reqRaw) as ExtendRequest;
  if (req.requesterId === acceptorId) {
    return { status: 'wrong_player' };
  }

  // Apply extension
  await Promise.all([
    prisma.match.update({ where: { id: matchId }, data: { extendedAt: new Date() } }),
    redis.set(CacheKeys.matchExtended(matchId), 'true', 'EX', EXTEND_FLAG_TTL),
    redis.del(CacheKeys.matchExtendReq(matchId)),
    resetReadyChecks(matchId, p1DiscordId, p2DiscordId),
  ]);

  return { status: 'ok' };
}

// ── Decline ───────────────────────────────────────────────────────────────────

/**
 * Declines a pending extension request. Simply removes the Redis key.
 * No match state changes — the original deadline stands.
 */
export async function declineExtension(matchId: number): Promise<void> {
  const redis = getRedisClient();
  await redis.del(CacheKeys.matchExtendReq(matchId));
}

// ── Query helpers ─────────────────────────────────────────────────────────────

/** Returns true if this match has already used its one extension. */
export async function isMatchExtended(matchId: number): Promise<boolean> {
  const redis = getRedisClient();
  return (await redis.exists(CacheKeys.matchExtended(matchId))) === 1;
}

/** Returns the pending extension request for a match, or null if none. */
export async function getPendingExtendRequest(matchId: number): Promise<ExtendRequest | null> {
  const redis = getRedisClient();
  const raw = await redis.get(CacheKeys.matchExtendReq(matchId));
  if (!raw) return null;
  return JSON.parse(raw) as ExtendRequest;
}
