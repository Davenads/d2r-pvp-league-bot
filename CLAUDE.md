# D2R PvP 1v1 League Bot — CLAUDE.md

## Project Overview

This is a Discord bot for managing a **Diablo 2 Resurrected (D2R) PvP 1v1 League**. It handles matchup rule lookups, banned matchup enforcement, deathmatch tracking, player registration, ladder standings, and mod administration — all backed by a Google Sheet as the source of truth.

**Primary stakeholder:** Stadium (main mod/administrator of the server)

---

## Tech Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js (LTS) |
| Language | TypeScript (strict mode) |
| Discord framework | discord.js v14 |
| Data source | Google Sheets API v4 |
| Cache | Redis (ioredis) — Heroku Redis add-on |
| Database | PostgreSQL (Heroku Postgres add-on) via Prisma ORM |
| Build | tsc / ts-node-dev for dev |
| Env management | dotenv |
| Deployment | Heroku (Procfile + GitHub autodeploy) |

> **Note:** SQLite is explicitly excluded. Heroku's ephemeral filesystem means any SQLite `.db` file is lost on every dyno restart or redeploy. All mutable state goes to Postgres (durable) or Redis (transient/cache).

---

## Background & Context

This project evolved from Discord discussions between:
- **Stadium** (main mod, underzjsp@gmail.com) — primary decision-maker on rules and build list
- **KIN-Jits / KIN-Fooz** — PvP knowledge contributor, charger main
- **sweatyBetty** (DFC community member) — original technical contributor, shared DFC build list and sheet structure
- **TOESHANK** — community contributor

The build list was derived from the **DFC** (D2 Fight Club, a separate PvP league) build classification, curated by the group to exclude off-meta/non-viable builds (blade sin, summon druid, singer barb were removed). Rules are based on **TDL rules** as the primary reference, with **BMPK rules** (DDL rules revised by Toeshank and Marvel) as secondary input.

The Google Sheet was initially set up by sweatyBetty: `https://docs.google.com/spreadsheets/d/1qjqnNmgTKkEJ0Ovvrp17Kwf8Pgu_8fkjSgoU_TLTY0I/edit`

---

## Google Sheets Data Source

The spreadsheet is the **single source of truth** for all game rules and league data. Never hardcode rule text — always pull from the sheet.

### Sheet Tabs

| Tab Name | Purpose | Update Frequency |
|---|---|---|
| `Banned matchups` | List of build vs build combinations that are outright banned from being played | Seasonal / mod-updated |
| `Matchups: Deathmatches` | Per-build list of Deathmatch alternatives (up to 5) | Seasonal / mod-updated |
| `Class Rules` | Per-class rules for all 7 classes; col A = class name, col B = multi-line cell with `Test rule(s)` as delimiter between regular and test rules | Seasonal / mod-updated |
| `1v1 Rules` | General tournament/league rules (General Rules, Map Rules, Item Rules sections) | Seasonal |
| `Questions` | FAQ / common questions | As needed |
| `Ladder` | Player standings / rankings; bot writes W/L/point increments directly on result confirm | Ongoing |

### Builds (26 total)

**Amazon:** CS Hybrid Bowa, CS Zon, Telebow, Walkbow
**Assassin:** Ghost, Hybrid, Spider, Trapper
**Barbarian:** BvA, BvC, Throw/WW Hybrid
**Druid:** Fire Druid, Shaman, Windy
**Necromancer:** Bone
**Paladin:** Charger, Hammerdin, T/V, V/C, V/T
**Sorceress:** Cold ES, Cold Vita, Fire ES, Fire Vita, Lite ES, Lite Vita

---

## Data Storage Strategy

### What Goes Where

| Data | Storage | Rationale |
|---|---|---|
| Banned list, deathmatches, class rules, general rules, FAQ | Redis (cached from Sheets) | Read-heavy, rarely changes, Sheets is source of truth |
| Ladder standings / leaderboard display | Google Sheets (`Ladder` tab) + Redis cache | Sheet is source of truth; bot reads and caches; bot writes W/L/point increments on result confirm |
| Player registration metadata, match history, warning counts | **PostgreSQL** | Durable, relational, survives dyno restarts |
| Active queue state, player state, concurrent match sets, farming cap, ready check counts, join locks | **Redis** | Transient — fine to lose on restart, fast access needed |
| Rule content (authoritative) | Google Sheets | Mods edit directly; bot reads and caches |

### Redis Cache Keys (namespaced `d2r:*`)

| Key Pattern | Purpose |
|---|---|
| `d2r:banned` | Sorted `A::B` strings for all banned pairings |
| `d2r:deathmatch:{build}` | Deathmatch opponent list per build |
| `d2r:deathmatches` | Full deathmatch map |
| `d2r:rules:general` | General 1v1 rules (from sheet) |
| `d2r:rules:class` | Class rules map (from sheet) |
| `d2r:faq` | FAQ entries (from sheet) |
| `d2r:ladder` | Cached ladder rows |
| `d2r:queue` | Redis list — FIFO queue of Discord IDs |
| `d2r:player:{id}:state` | `"idle"` / `"queued"` / `"in_match"` |
| `d2r:matches:active:{id}` | Redis SET of active match IDs per player (concurrent match support) |
| `d2r:farming:{x}:{y}` | Farming cap counter with TTL |
| `d2r:mirror:req:{nonce}` | Pending mirror match request |
| `d2r:forced:{id}` | Forced match assignment `{ assignedAt }` |
| `d2r:forced:thread:{id}` | Thread ID of forced assignment notification thread |
| `d2r:match:rc:{matchId}:{id}` | Ready check click count per player per match (8-day TTL) |
| `d2r:match:rc:last:{matchId}:{id}` | Timestamp of last ready check click (8-day TTL) |
| `d2r:match:extend:req:{matchId}` | Pending extension request JSON (48h TTL) |
| `d2r:match:extended:{matchId}` | One-extension sentinel flag (8-day TTL) |
| `d2r:leaderboard:msgid` | Discord message ID of the pinned leaderboard embed |
| `d2r:queue:btn:msgid` | Discord message ID of the persistent Join Queue button embed |
| `d2r:action:panel:msgid` | Discord message ID of the Register/Join Queue action panel |
| `d2r:info:hub:msgid` | JSON `{ channelId, messageId }` of the info hub post |
| `d2r:queue:join:lock:{id}` | Per-player distributed lock (15s TTL) to prevent duplicate queue joins |

### PostgreSQL (via Prisma)

Stores: `Player`, `Match`, `Warning`, `Season` tables.

**Match model notable fields:**
- `extendedAt` — set when a 3-day extension is granted (null = not extended)
- `rcResolved` — true when result was determined by ready check (not a played match)
- `threadId` — Discord thread snowflake for the match thread
- `reportedAt` — match creation timestamp (used as deadline base)
- `confirmedAt` — result confirmation timestamp

Prisma migrations handle schema changes cleanly across deploys.

---

## Bot Architecture

```
src/
  commands/
    admin/
      acceptMirror.ts       # Mod: accept mirror on behalf of a player
      cancelMatch.ts        # Mod: cancel an active match
      clearPlayerState.ts   # Mod: reset a player's Redis state
      clearWarning.ts       # Mod: remove a warning from a player
      forceMatch.ts         # Mod: force a specific matchup between two players
      postActionPanel.ts    # Mod: post/refresh Register+Join Queue panel in leaderboard channel
      postInfoHub.ts        # Mod: post/refresh button-based info hub in current channel
      queuePlayer.ts        # Mod: queue a player on their behalf
      refreshCache.ts       # Mod: force-refresh sheet cache (all or specific tab)
      refreshLadder.ts      # Mod: manually trigger leaderboard embed refresh
      registerPlayer.ts     # Mod: register a player on their behalf
      removePlayer.ts       # Mod: remove a player from the league
      season.ts             # Mod: season management (start/end)
      setResult.ts          # Mod: override a match result
      viewPlayerState.ts    # Mod: inspect a player's Redis state
      viewQueue.ts          # Mod: view current queue order
      warn.ts               # Mod: manually issue a warning
    banned.ts               # /banned-matchups
    class-rules.ts          # /class-rules
    deathmatch.ts           # /deathmatch
    faq.ts                  # /faq
    help.ts                 # /help
    ladder.ts               # /ladder
    leaveQueue.ts           # /leave-queue
    player.ts               # /player
    queue.ts                # /queue
    register.ts             # /register
    reportWin.ts            # /report-win
    requestMirror.ts        # /request-mirror
    rules.ts                # /rules
    updateBuilds.ts         # /update-builds
    withdraw.ts             # /withdraw
  config/
    channels.ts             # Hardcoded Discord channel IDs
    roles.ts                # Hardcoded Discord role IDs (mod role)
  db/
    prisma/
      schema.prisma         # Player, Match, Warning, Season table definitions
    client.ts               # Prisma client singleton
  events/
    interactionCreate.ts    # Slash commands + all button interaction routing
    ready.ts                # Bot startup logic
  services/
    blacklist.ts            # Player blacklist enforcement
    cache.ts                # Redis wrapper (ioredis)
    content.ts              # Sheet content fetching (rules, class rules, FAQ)
    ladder.ts               # Ladder read/write logic — Google Sheets + Redis cache
    leaderboardEmbed.ts     # Pinned leaderboard embed management
    matchExtend.ts          # Mutual-consent match extension flow
    matchup.ts              # Banned matchup + deathmatch lookup (sheets + cache)
    queue.ts                # Queue management (Redis state), match creation, join lock
    queueButton.ts          # Persistent Join Queue button embed management
    readyCheck.ts           # Ready check tracking, deadline resolution, half-point awards
    scheduler.ts            # Background jobs (7 jobs + daily queue nudges)
    sheets.ts               # Google Sheets API wrapper
  types/
    index.ts                # Shared TypeScript types/interfaces + CacheKeys
  utils/
    buildList.ts            # Canonical build list + aliases + getClassFromBuild()
    classEmojis.ts          # Class emoji mappings
    formatters.ts           # Discord embed builders, shared formatting utilities
    matchResult.ts          # Match result processing (Prisma write-back + ladder update)
    matchupUI.ts            # Match announcement embeds + bottom panel buttons
    modGuard.ts             # Mod role check utility (assertModRole)
    queueJoin.ts            # Shared queue join logic (used by /queue and queue_join button)
    rulesParser.ts          # Sheet rules text parser
  config.ts                 # Env var loading and validation
  deploy-commands.ts        # Slash command registration script
  index.ts                  # Entry point — registers commands, starts bot, starts scheduler
```

### Procfile (Heroku)
```
web: node dist/index.js
release: npx prisma migrate deploy
```
The `release` phase runs Prisma migrations automatically on every deploy before the dyno starts.

---

## Commands

### Player-Facing

| Command | Description |
|---|---|
| `/class-rules [class]` | Show class-specific rules — omit class to see all 7 classes |
| `/rules` | Display the general D2R 1v1 League rules |
| `/banned-matchups [build]` | List all banned matchups (optionally filtered by build) |
| `/deathmatch <build>` | Show the deathmatch alternatives for a given build |
| `/ladder` | Show current league standings (rank + name only, no points) |
| `/player <name>` | Show a player's stats, build(s), and record |
| `/faq [topic]` | Look up FAQ entries |
| `/register <build1> <build2> [build3] [build4] [build5]` | Register for the league — minimum 2 builds required |
| `/update-builds` | Change your registered builds |
| `/withdraw` | Remove yourself from the ladder |
| `/help` | Show available commands |

### Match Management

| Command | Description |
|---|---|
| `/queue` | Enter the match queue (FIFO; queue position private) |
| `/leave-queue` | Leave the match queue (shows rejoin button on confirmation) |
| `/report-win` | Report a match result — winner selects opponent from active matches |
| `/request-mirror <opponent> <build>` | Request a mirror match (both players must consent) |

> **Note:** Results can also be reported via the winner buttons posted in the match thread.

### Mod / Admin

| Command | Description |
|---|---|
| `/refresh-cache [tab]` | Force-refresh sheet cache (all or specific tab) |
| `/admin-set-result` | Override a match result |
| `/admin-register` | Register a player on their behalf |
| `/admin-remove-player` | Remove a player from the league |
| `/admin-view-queue` | View current queue (mod-only) |
| `/admin-warn` | Manually issue a warning to a player |
| `/admin-clear-warning` | Remove a warning from a player's record |
| `/admin-queue-player` | Place a player in the match queue on their behalf |
| `/admin-cancel-match` | Cancel an active match and re-queue both players |
| `/admin-accept-mirror` | Accept a mirror match request on a player's behalf |
| `/admin-force-match` | Force a specific matchup between two players |
| `/admin-clear-player-state` | Reset a player's Redis queue/match state |
| `/admin-view-player-state` | Inspect a player's current Redis state |
| `/admin-post-action-panel` | Post/refresh the Register+Join Queue action panel in the leaderboard channel |
| `/admin-post-info-hub` | Post/refresh the 6-button info hub in the current channel |
| `/admin-refresh-ladder` | Manually trigger a leaderboard embed refresh |
| `/admin-season` | Season management (start/end season) |

---

## Development Standards

- **TypeScript strict mode** — no `any` types, explicit return types on all functions
- **Slash commands only** — no prefix-based commands
- **Embeds for all responses** — use Discord embeds for formatted output, not plain text walls
- **Ephemeral for errors** — errors and invalid usage replies should be ephemeral
- **Build name autocomplete** — all commands taking a build name must use `autocomplete` interactions backed by the canonical build list
- **No hardcoded rule text** — all rule content must come from the Google Sheet
- **All sheet reads go through the cache service** — never call the Sheets API directly from a command handler
- **Environment variables** for all secrets (bot token, sheet ID, Redis URL, Google credentials)
- **Channel IDs in `src/config/channels.ts`** — Discord channel IDs are non-sensitive snowflakes; store in committed config file, not env vars. Import via `CHANNELS` export.
- **Graceful error handling** — catch and log all errors; always reply to the user with a user-friendly message

---

## Environment Variables

```env
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=          # Dev server ID (for guild-scoped command registration)
GOOGLE_SHEET_ID=
GOOGLE_SERVICE_ACCOUNT_EMAIL=
GOOGLE_PRIVATE_KEY=
REDIS_URL=redis://localhost:6379
DATABASE_URL=              # Postgres connection string (set automatically by Heroku Postgres add-on)
CACHE_TTL_RULES=3600        # seconds
CACHE_TTL_LADDER=60         # seconds
MATCH_CADENCE_DAYS=3        # how often players are expected to play
WARNING_THRESHOLD=5         # warnings before auto-removal from ladder
FARMING_CAP_HOURS=24        # cooldown window for repeat opponent pairing
FARMING_CAP_MAX=2           # max times same pairing allowed within window
NODE_ENV=development
```

---

## Match Point Values

| Result Type | Winner | Loser |
|---|---|---|
| Standard win | +1 pt | 0 |
| Deathmatch win | +1 pt | 0 |
| Tournament win | +2 pts | +1 pt |
| RC auto-resolution | +0.5 pts | -0.5 pts (floored at 0) |

Points are written directly to the `Ladder` Google Sheet tab on result confirmation. Formula columns (`W%`, `Rank`) update automatically in the sheet. Points are tracked internally but **never displayed publicly** — `/ladder` shows rank + name only.

---

## Scheduler Jobs

The scheduler (`src/services/scheduler.ts`) starts on bot startup via `startScheduler(client)` and runs 7 recurring jobs plus daily queue nudges. All use `setTimeout`/`setInterval` (not cron) so they resume from zero on dyno restart — no missed-window recovery.

| Job | Interval | Offset | Purpose |
|---|---|---|---|
| Match cadence check | Every 4h | 2min boot delay | Finds overdue players, issues forced match assignment (matchResults ping + DM + private thread) |
| Warning escalation | Every 4h | 32min boot delay | Issues warning 24h after unacknowledged forced assignment; auto-removes at threshold |
| Leaderboard refresh | Every 1h | 30s boot delay | Edits the pinned leaderboard embed to reflect current sheet standings |
| Thread cleanup | Every 4h | 60min offset | Archives confirmed match threads 24h after confirmation |
| Warning decay | Every 4h | 90min offset | Clears all warnings for players who played matches on 3 consecutive calendar days |
| Match reminder | Every 24h | 2h offset | Pings players in thread + reposts winner buttons if match open >24h |
| RC deadline resolution | Every 1h | 45min offset | Resolves PENDING matches past their 3-day deadline via ready check comparison |
| Queue nudge | Daily 22:00 UTC (6pm EST) and 02:00 UTC (10pm EST) | — | Posts Join Queue embed in #1v1-chat if queue is empty |

---

## Key Design Decisions

1. **Google Sheets is the source of truth for both rule content and ladder standings.** Mods update rules directly in the sheet. The bot reads all sheet tabs and caches in Redis. On match result confirmation, the bot writes W/L/point increments directly to the `Ladder` tab (by Discord ID lookup). Formula columns (`W%`, `Rank`) update automatically in the sheet. Player registration metadata, match history, and warnings are stored in **PostgreSQL**.

2. **SQLite is explicitly off the table.** Heroku's ephemeral filesystem destroys SQLite files on every dyno restart. All durable state uses Heroku Postgres.

3. **Build registration uses a fixed autocomplete list, not free text.** This was an explicit design requirement ("choosing from a list of available builds to maintain data integrity"). Free-form build entry breaks matchup automation.

4. **Players must register exactly 2 builds minimum (up to 5).** `build1` and `build2` are required fields in the Prisma schema. `build3`–`build5` are optional. When two queued players are matched, the bot computes all NxM build pairings and filters out any that are on the banned list. Each valid pairing is checked against the `Matchups: Deathmatches` tab — if one build lists the other as a deathmatch opponent, that pairing is tagged DEATHMATCH (FT2); otherwise STANDARD (FT4). The bot **randomly selects** one valid pairing with no player input. The Prisma `Match` record is created immediately. If all pairings are banned, an override prompt is shown — if override is accepted, the bot randomly picks from all pairings (including banned); if declined, both players are re-queued.

5. **Two result recording modes.** Stadium requested tracking test-rule match outcomes separately from regular match outcomes. Both flows look the same to players but are stored with different `MatchType` values (`STANDARD` vs `TEST_RULE`).

6. **Mirror matches require mutual consent.** Mirrors are allowed but both players must agree. The bot facilitates this via a button-based consent flow initiated by `/request-mirror`.

7. **Build name resolution.** Build names support partial/fuzzy matching and aliases (e.g., "hammerdin" → "Paladin - Hammerdin"). A canonical build list with aliases lives in `src/utils/buildList.ts`. Class name is extracted from a build name by splitting on ` - ` and taking the first segment (e.g., `"Druid - Windy"` → `"Druid"`); this is done via `getClassFromBuild()` in `buildList.ts`.

8. **Banned matchup handling.** The banned list is enforced during queue pairing — all NxM build pairings are computed, banned ones filtered out. If all are banned, an override prompt is shown. Banned pairings are stored as sorted `A::B` keys in Redis (`d2r:banned`).

9. **Deathmatch is triggered by specific build pairings.** The `Matchups: Deathmatches` tab defines which matchups are inherently deathmatches (e.g., Barb vs Hammerdin). When the bot randomly selects a pairing, it checks this tab — if EITHER build lists the other as a deathmatch opponent, the match is typed DEATHMATCH (FT2). A mutual listing is not required. Each build has up to 5 deathmatch opponents. The tab is cached in Redis.

10. **Queue is FIFO and private.** Queue membership is never exposed to other players — only mods can view it via `/admin-view-queue`. This prevents cherry-picking opponents. When a player joins the queue, they are immediately matched with the next player already in queue (if one exists). On match, both players are set to `in_match` state in Redis, a private thread is created in `#1v1-match-results`, the bot randomly selects a non-banned pairing (tagged STANDARD or DEATHMATCH), announces it, and creates the Prisma `Match` record immediately.

11. **Queue mod-ops notifications are anonymized.** Named player identity is never posted to mod-ops on queue join. Mod-ops receives only: "A player joined the queue — position #N". For admin-queued players: "A player was queued by mod @X — position #N". Named notifications would let mods who are also players cherry-pick opponents. Mods use `/admin-view-queue` on-demand for full queue state.

12. **Queue join deduplication via Redis lock.** `executeQueueJoin` acquires a per-player NX lock (`d2r:queue:join:lock:{id}`, 15s TTL) before any processing. A second concurrent request (e.g., rapid button double-click) gets rejected immediately. The lock is always released in a `finally` block.

13. **Concurrent matches are supported and intentional.** A player already in an active match (`in_match` state) is allowed to re-queue and be matched again. Active match IDs are tracked per player in a Redis SET (`d2r:matches:active:{discordId}`) rather than a single value, so multiple simultaneous matches are fully supported. The `in_match` player state is not cleared until ALL of a player's active matches are resolved — `resolvePlayerStateAfterMatch` checks `hasActiveMatches` before setting state to `idle`. This means `/queue` and the Join Queue button must NOT block players who are `in_match`. The `admin-queue-player` command must also allow queuing `in_match` players for consistency.

14. **Result reporting is winner-initiated, no confirmation required.** The winner reports via `/report-win` or via the winner buttons posted in the match thread. No opponent confirmation step, no time window. Winner buttons are blue (Primary style). For disputes, players contact a 1v1 moderator directly. `/report-win` looks up matches via Prisma, not Redis — no Redis dependency for the result flow.

15. **Ready check system.** Each match thread has a persistent bottom panel with a green "Ready Check" button. Players click it to signal they are available to play; there is a **4-hour cooldown** per player per match. Click counts are stored in Redis (8-day TTL per key). When a match's **3-day deadline** expires (base deadline = `reportedAt + 3 days`; post-extension deadline = `extendedAt + 3 days`), the scheduler resolves it:
    - Higher RC count → that player wins (half-point result, warning issued to loser, thread archived)
    - Equal counts, not yet extended → auto-extend 3 days, reset RC counts, post notice in thread
    - Equal counts, already extended → escalate to mod-logs, require manual resolution

16. **Match extension system.** Either player can request a 3-day extension via the "Extend" button in the match thread bottom panel. The opponent has **48 hours** to accept or decline. Only **one extension is allowed per match** (enforced by Redis sentinel key). On acceptance: RC counts reset, `extendedAt` written to Prisma, match deadline shifts +3 days. Extensions can also be triggered automatically by the scheduler if RC counts are tied at deadline (first time only).

17. **Warning system with decay.** Unresponsive players receive warnings stored in Postgres (`Warning` table). Reaching `WARNING_THRESHOLD` (default: 5) triggers automatic removal from the ladder. Mods can manually issue or clear warnings. **Warning decay:** the scheduler automatically clears all warnings for any player who has confirmed matches on 3 distinct consecutive UTC calendar days within the past 3 days — signals genuine re-engagement.

18. **Forced match cadence.** Players on the ladder are expected to play approximately every 3 days. The scheduler finds overdue players (lastMatchAt null/stale, or registered long enough ago) and issues a forced match assignment. The assignment fires three notifications simultaneously: a ping in `#1v1-match-results`, a DM to the player, and a private thread in `#1v1-match-results` (with all mods added). The thread ID is stored in Redis and archived automatically when the player queues. If unacknowledged after 24 hours, the warning escalation job issues a warning.

19. **Match thread contents (in order).** When two players are matched, the bot creates a private thread in `#1v1-match-results`, adds both players, and posts: (1) match announcement embed (builds, FT2/FT4, report instruction), (2) a ping to the mod role (all mods are also silently added to the thread), (3) general rules embeds, (4) class rules embed(s) for each class involved (deduplicated), (5) a bottom command panel with winner buttons (blue), a Ready Check button (green), and an Extend Request button. Requires `MANAGE_THREADS` permission.

20. **Match reminder.** The scheduler posts a reminder ping + fresh winner buttons inside any match thread that has been open (PENDING) for more than 24 hours. This runs every 24 hours.

21. **Thread auto-archive.** The scheduler archives match threads 24 hours after a result is confirmed. Players can also archive their own thread via a button posted after result confirmation.

22. **Leaderboard display is rank + name only.** The `/ladder` command shows everyone in ranked order with no W/L, points, or win% visible. Stadium's rationale: hiding the score gap between #1 and #2 keeps players motivated. Points are tracked internally but never displayed publicly. Rank is determined by the Google Sheet formula: primary sort = hidden points; tiebreaker 1 = W/L%; tiebreaker 2 = total wins. The leaderboard embed is pinned in `#1v1-leaderboard` and refreshed every hour by the scheduler.

23. **Registration is open all season.** `/register` has no sign-up window restriction — players can join at any time during an active season. At least 2 builds must be registered.

24. **Farming cap.** A player cannot be matched against the same opponent more than `FARMING_CAP_MAX` times (default: 2) within a `FARMING_CAP_HOURS` window (default: 24h). Tracked in Redis with TTL.

25. **Persistent UI embeds.** The bot maintains three persistent Discord embeds, each with a Redis-tracked message ID for recovery across restarts:
    - **Join Queue button** (`#1v1-queue`) — posted/refreshed by `ensureQueueButtonExists` on startup
    - **Action panel** (`#1v1-leaderboard`) — Register + Join Queue buttons; posted via `/admin-post-action-panel`
    - **Info hub** (any channel, designed for rules channel) — 6 buttons: Register, Join Queue, Valid Builds, Report Wins, Commands, Rules; posted via `/admin-post-info-hub`

26. **Channel consolidation.** Several originally-planned separate channels were merged in production. The `CHANNELS` constant reflects actual IDs:
    - `modLogs` and `modQueue` both point to `1v1-mod-ops` (one mod channel)
    - `matchThreads` and `matchResults` both point to `1v1-match-results` (threads are created within that channel)
    - `signUpHere` and `queue` both point to `1v1-queue` (Join Queue button lives here)
    - `chat` (`1v1-chat`) is where the daily queue nudge posts

---

## Discord Server Channel Structure

The bot operates in the **1v1 League** category of the production Discord server.

### Channel IDs (hardcoded in `src/config/channels.ts`)

| Key | Channel | ID | Purpose |
|---|---|---|---|
| `modLogs` | `1v1-mod-ops` | 1491240646168543322 | All bot admin action logs AND queue state (merged) |
| `modQueue` | `1v1-mod-ops` | 1491240646168543322 | Same as modLogs — single mod channel |
| `queue` | `1v1-queue` | 1491240398268403934 | Hosts the persistent Join Queue button embed |
| `signUpHere` | `1v1-queue` | 1491240398268403934 | Same as queue — merged channels |
| `matchResults` | `1v1-match-results` | 1491240439708123228 | All match assignments, results, reminders, forced match pings |
| `matchThreads` | `1v1-match-results` | 1491240439708123228 | Same as matchResults — private threads created within |
| `leaderboard` | `1v1-leaderboard` | 1491240333005033492 | Pinned standings embed + action panel |
| `announcements` | `1v1-announcements` | 1491240168294977617 | Season/major event announcements |
| `chat` | `1v1-chat` | 1491240474705399950 | Queue nudge posts (6pm + 10pm EST daily) |

### Actual Channel Layout
```
1v1 League
├── 1v1-mod-ops         [Text — mod only; bot logs all admin actions + anonymized queue state here]
├── 1v1-announcements   [Announcement]
├── 1v1-rules           [Announcement — static, mod posts manually]
├── 1v1-info            [Announcement — static, mod posts manually]
├── 1v1-queue           [Text — hosts persistent Join Queue button embed]
├── 1v1-leaderboard     [Text — pinned standings embed + action panel]
├── 1v1-match-results   [Text — all match bot posts; private threads created here]
├── 1v1-chat            [Text — general community; queue nudge posts here]
├── 1v1 Voice Chat      [Voice]
└── 1v1 Voice Chat 2    [Voice]
```

---

## Slash Command Deployment

Slash commands must be explicitly registered with Discord via `npm run deploy` (runs `src/deploy-commands.ts`). This is separate from the Heroku autodeploy — pushing to GitHub deploys the bot code automatically, but **command definitions are not updated in Discord until `npm run deploy` is run manually**.

**Run `npm run deploy` whenever any of the following change:**
- A new slash command is added (`src/commands/**/*.ts`)
- A command is renamed (`setName(...)`)
- A command description changes
- Options are added, removed, renamed, or reordered on any command
- `setRequired()` status changes on any option
- A command is deleted (must remove from deploy list too)

**Do NOT need to redeploy for:**
- Changes to command handler logic (how the command behaves)
- Button interaction changes
- Scheduler changes
- Service/utility changes

Commands are registered to both guilds (production + dev) simultaneously. Changes are instant for guild-scoped commands — no propagation delay.

```bash
npm run deploy
```

---

## Implementation Protocol

When the user asks to implement multiple features/commands in sequence:

- **One at a time, always.** Implement one item, push, post a review message, then STOP.
- **Wait for explicit confirmation** before proceeding to the next item — do not say "going now" and immediately continue.
- This applies even if items seem small or closely related.

---

## Files in This Repo

| File | Purpose |
|---|---|
| `CLAUDE.md` | This file — project context for Claude Code |
| `Images/` | Screenshots of the Google Sheet structure |
| `plan/` | Planning docs (gitignored — not shipped); includes `ladder-schema.md` for Google Sheet column reference, `sheets-data-reference.md` for tab structure |
| `src/config/channels.ts` | Hardcoded Discord channel IDs for production server |
| `src/config/roles.ts` | Hardcoded Discord role IDs (mod role) |
| `prisma/schema.prisma` | Postgres schema — Player, Match, Warning, Season |
