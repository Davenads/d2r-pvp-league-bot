# Bot Architecture & Data Flow

## System Diagram

```
Discord Users / Mods
        │
        │ slash commands / interactions / button clicks
        ▼
┌─────────────────────────────────────────────────┐
│                discord.js Bot                   │
│                                                 │
│  ┌──────────┐   ┌──────────────────────────┐   │
│  │ Commands │──▶│      Services Layer       │   │
│  │ Handlers │   │                           │   │
│  └──────────┘   │  ┌──────────────────────┐ │  │
│                 │  │   MatchupService      │ │  │
│  ┌──────────┐   │  ├──────────────────────┤ │  │
│  │  Events  │   │  │   LadderService       │ │  │
│  │ Handlers │   │  ├──────────────────────┤ │  │
│  └──────────┘   │  │   QueueService        │ │  │
│                 │  ├──────────────────────┤ │  │
│  ┌──────────┐   │  │   RulesService        │ │  │
│  │Scheduler │   │  ├──────────────────────┤ │  │
│  │ (cron)   │   │  │   WarningService      │ │  │
│  └──────────┘   │  └──────────┬───────────┘ │  │
│                 └─────────────┼─────────────┘  │
└───────────────────────────────┼────────────────┘
                                │
              ┌─────────────────┼──────────────────┐
              │                 │                  │
              ▼                 ▼                  ▼
   ┌─────────────────┐  ┌─────────────┐  ┌──────────────────┐
   │   Redis Cache   │  │  PostgreSQL │  │  Google Sheets   │
   │   (ioredis)     │  │  (Prisma)   │  │    API v4        │
   │                 │  │             │  │                  │
   │  - matchups     │  │  - Player   │  │  - Matchups tab  │
   │  - banned       │  │  - Match    │  │  - Banned tab    │
   │  - deathmatches │  │  - Warning  │  │  - Deathmatches  │
   │  - rules / faq  │  │  - Season   │  │  - TDL Rules     │
   │  - queue state  │  │             │  │  - Questions     │
   │  - farming TTL  │  │             │  │                  │
   └─────────────────┘  └─────────────┘  └──────────────────┘
        transient             durable         rule content
```

---

## Request Flow: Matchup Lookup

```
/matchup "Ghost" "Trapper"
        │
        ▼
  Normalize build names
  (fuzzy match → canonical name)
        │
        ├──▶ Is this a banned matchup?
        │         │
        │    [Redis: d2r:banned]──miss──▶ Sheets API ──▶ populate cache
        │         │
        │    If BANNED: reply with "BANNED MATCHUP" embed, stop
        │
        ▼
  Look up matchup rules
  [Redis: d2r:matchup:<buildA>:<buildB>]
        │
      miss ──▶ Sheets API (Matchups tab) ──▶ populate cache
        │
        ▼
  Build Discord embed with rules
  (include: your rules + opponent rules + any shared restrictions)
        │
        ▼
  Reply to interaction
```

---

## Cache Key Schema

```
d2r:matchup:<canonical_build_a>:<canonical_build_b>   # Normalized: alphabetical order
d2r:banned                                             # Full banned list (JSON array)
d2r:deathmatch:<canonical_build>                       # Deathmatch alternatives for build
d2r:rules:general                                      # TDL general rules text
d2r:faq                                                # Full FAQ (JSON array of {q, a})
d2r:ladder                                             # Full ladder (JSON array)
```

---

## Google Sheets Access Pattern

- Use a **service account** (no OAuth flow, bot runs headlessly)
- Service account email gets **Viewer** access to the sheet (read-only for rules; if bot writes results, needs Editor on Ladder tab only)
- Tab reads use the `googleapis` Node.js client: `sheets.spreadsheets.values.get`
- Named ranges are preferred over raw `A1:Z100` ranges for resilience to row/column additions
- On cold start, pre-warm the cache for all rule tabs (matchups, banned, deathmatches, general rules) so first user request is fast

---

## Sheets API Call Locations

All Sheets API calls go through `src/services/sheets.ts`. No other file imports the Google API client directly. The cache service (`src/services/cache.ts`) wraps Redis. The matchup/ladder/rules services compose these two.

```
Command Handler
    └──▶ MatchupService.getMatchup(buildA, buildB)
              └──▶ CacheService.get(key)
                      ├── hit:  return cached value
                      └── miss: SheetsService.getMatchupMatrix()
                                    └──▶ CacheService.set(key, value, ttl)
                                    └──▶ return value
```

---

## Command Registration

- Commands are registered as **guild commands** during development (instant propagation)
- Commands are registered as **global commands** in production (up to 1 hour propagation)
- A `deploy-commands.ts` script handles registration separately from the bot process
- All commands use `autocomplete` for build name inputs

---

## Build Name Normalization

Build names from user input need to resolve to canonical names used as sheet row/column headers.

```typescript
// src/utils/buildList.ts
export const BUILD_ALIASES: Record<string, string> = {
  "hammerdin": "Paladin - Hammerdin",
  "hdin": "Paladin - Hammerdin",
  "ghost": "Assassin - Ghost",
  "sin": "Assassin - Ghost",  // context-dependent — may need disambiguation
  "windy": "Druid - Windy",
  "bva": "Barbarian - BvA",
  "bvc": "Barbarian - BvC",
  "bone": "Necromancer - Bone",
  "necro": "Necromancer - Bone",
  "charger": "Paladin - Charger",
  // ... etc
};
```

Autocomplete should filter `CANONICAL_BUILDS` list as the user types.

---

## Error Handling Strategy

| Scenario | Response |
|---|---|
| Google Sheets API down | Return cached data if available; if cache also empty, return ephemeral error with "rules data temporarily unavailable" |
| Redis down | Fall back to direct Sheets API calls (log warning, don't crash) |
| Unknown build name | Ephemeral error with suggested closest matches |
| Banned matchup queried | Prominent embed noting it's banned (not an error, but a distinct state) |
| Match result conflict | Route to mod review; bot does not auto-resolve |

---

## Match Lifecycle State Machine

```
Player runs /queue
    │
    ▼
QueueService.enqueue(player)  ──▶ Redis: d2r:queue (FIFO list)
    │
    ├── Queue was empty? Wait for next player to join
    │
    └── Match found (2 players in queue)
            │
            ▼
        Check farming cap (Redis TTL: d2r:farming:<p1>:<p2>)
            │
            ├── Farming cap hit? → Error embed (ephemeral), both players remain in queue
            │
            └── OK → Create match
                    │
                    ▼
                Determine build pairing (least-disadvantaged algorithm — TBD)
                    │
                    ▼
                Create Discord thread (MANAGE_THREADS permission required)
                Post matchup embed in thread + tag both players
                    │
                    ▼
                Match state in Redis: d2r:match:<matchId>
                Match record in Postgres: Match (status: PENDING_ACKNOWLEDGMENT)
                    │
                    ▼
                Both players must /im-ready (or button click in thread)
                    │
                    ├── Timeout without acknowledgment → Warning issued (Postgres: Warning)
                    │   3–5 warnings → auto-remove from ladder
                    │
                    └── Both acknowledged → Match status: IN_PROGRESS
                            │
                            ▼
                        Winner runs /report-win @opponent
                            │
                            ▼
                        Opponent confirms (button, 24h window)
                            │
                            ├── Dispute / no confirm → Route to mod review
                            │
                            └── Confirmed → Update Postgres (Match status: COMPLETE)
                                    │
                                    ▼
                                Recalculate ladder standings in Postgres
                                Invalidate Redis ladder cache
                                Post result embed in #results channel
                                Archive/lock match thread
                                    │
                                    ▼
                                "Re-queue?" button offered to both players
```

## Ladder Write Flow

Bot writes match results directly to **PostgreSQL** (not to Google Sheets). The Ladder tab in Google Sheets is **read-only** from the bot's perspective — it is only used if mods maintain a separate human-readable copy.

```
Match confirmed
    │
    ▼
LadderService.recordResult(matchId, winnerId, loserId)
    │
    ├── Postgres: UPDATE Player SET wins/losses/points WHERE id IN (...)
    ├── Postgres: UPDATE Match SET status = 'COMPLETE'
    └── Redis: DEL d2r:ladder  (cache invalidation)
```

## Forced Match Cadence (Scheduler)

A cron job runs on a configurable interval (e.g., every 6 hours) to check for players overdue for a match:

```
Scheduler fires (node-cron)
    │
    ▼
Query Postgres: players WHERE last_match_at < NOW() - MATCH_CADENCE_DAYS
AND status = 'ACTIVE'
    │
    ▼
For each overdue player:
    ├── Already in queue? Skip
    └── Not in queue → Force-assign match if opponent available
            │
            ├── No opponent available → DM player with nudge (no warning yet)
            └── Opponent assigned → Create thread, require /im-ready acknowledgment
                    │
                    └── No ack within window → Issue warning (Postgres: Warning)
```

## Warning System

```
Postgres: Warning table
  - playerId
  - reason (ENUM: NO_ACK, NO_SHOW, MANUAL)
  - createdAt
  - clearedAt (nullable)
  - clearedBy (mod Discord ID, nullable)

Active warning count = COUNT WHERE clearedAt IS NULL

On WARNING_THRESHOLD reached:
  → Remove player from ladder (Player.status = 'REMOVED')
  → Post mod notification in #admin channel
  → DM player with removal notice
```

---

## Project File Structure (Target)

```
D2R-PvP-1v1-Bot/
├── src/
│   ├── commands/
│   │   ├── matchup.ts
│   │   ├── banned.ts
│   │   ├── deathmatch.ts
│   │   ├── rules.ts
│   │   ├── ladder.ts
│   │   ├── player.ts
│   │   ├── faq.ts
│   │   ├── report.ts
│   │   └── admin/
│   │       ├── refreshCache.ts
│   │       ├── setResult.ts
│   │       ├── registerPlayer.ts
│   │       └── removePlayer.ts
│   ├── events/
│   │   ├── ready.ts
│   │   └── interactionCreate.ts
│   ├── services/
│   │   ├── sheets.ts
│   │   ├── cache.ts
│   │   ├── matchup.ts
│   │   ├── ladder.ts
│   │   └── rules.ts
│   ├── utils/
│   │   ├── buildList.ts
│   │   └── formatters.ts
│   ├── types/
│   │   └── index.ts
│   ├── config.ts
│   ├── index.ts
│   └── deploy-commands.ts
├── .env
├── .env.example
├── package.json
├── tsconfig.json
└── CLAUDE.md
```
