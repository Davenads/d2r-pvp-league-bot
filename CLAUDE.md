# D2R PvP 1v1 League Bot — CLAUDE.md

## Project Overview

This is a Discord bot for managing a **Diablo 2 Resurrected (D2R) PvP 1v1 League** (the "TDL" league based on sheet tab naming). It handles matchup rule lookups, banned matchup enforcement, deathmatch tracking, player registration, ladder standings, and mod administration — all backed by a Google Sheet as the source of truth.

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
| `Matchups` | 26×26 build matrix — each cell contains the ruleset text for that specific matchup | Seasonal / mod-updated |
| `Banned matchups` | List of build vs build combinations that are outright banned from being played | Seasonal / mod-updated |
| `Matchups: Deathmatches` | Per-build list of Deathmatch alternatives (up to 5) | Seasonal / mod-updated |
| `TDL Rules` | General tournament/league rules | Seasonal |
| `Questions` | FAQ / common questions | As needed |
| `Ladder` | Player standings / rankings | Ongoing (updated on match result) |
| `DFC` | Not used by this bot — disregard | N/A |

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
| Matchup rules, banned list, deathmatches, TDL rules, FAQ | Redis (cached from Sheets) | Read-heavy, rarely changes, Sheets is source of truth |
| Player records, match history, warning counts, ladder standings | **PostgreSQL** | Durable, relational, survives dyno restarts |
| Active queue state, current match state, farming cap tracking | **Redis** | Transient — fine to lose on restart, fast access needed |
| Rule content (authoritative) | Google Sheets | Mods edit directly; bot reads and caches |

### Redis Caching
- **All sheet data should be cached in Redis** to avoid API rate limits and reduce latency
- Cache TTL configurable per tab type:
  - Rules/matchups (rarely changes): long TTL (e.g., 1 hour or until manually invalidated)
  - Ladder display: short TTL or invalidate on write
- Provide a mod-only `/refresh-cache` command to force-refresh all or specific tabs
- Cache keys namespaced: `d2r:matchups:<build_a>:<build_b>`, `d2r:banned:...`, `d2r:queue:...`, etc.

### PostgreSQL (via Prisma)
- Stores: `Player`, `Match`, `Warning`, `Season` tables
- Bot writes match results and warning counts to Postgres, not to Google Sheets
- Ladder display reads from Postgres (with Redis cache layer)
- Prisma migrations handle schema changes cleanly across deploys

---

## Bot Architecture

```
src/
  commands/           # Slash command handlers (one file per command or group)
  events/             # Discord event handlers (ready, interactionCreate, etc.)
  services/
    sheets.ts         # Google Sheets API wrapper
    cache.ts          # Redis wrapper (ioredis)
    matchup.ts        # Matchup lookup logic (combines sheets + cache)
    ladder.ts         # Ladder read/write logic (reads Postgres, caches in Redis)
    queue.ts          # Queue management (Redis state) + match creation
    scheduler.ts      # Cron jobs: forced match cadence, warning escalation
  db/
    prisma/
      schema.prisma   # Player, Match, Warning, Season table definitions
    client.ts         # Prisma client singleton
  utils/
    buildList.ts      # Canonical list of builds + aliases
    formatters.ts     # Discord embed builders, message formatters
  types/
    index.ts          # Shared TypeScript types/interfaces
  config.ts           # Env var loading and validation
  index.ts            # Entry point — registers commands, starts bot
```

### Procfile (Heroku)
```
web: node dist/index.js
release: npx prisma migrate deploy
```
The `release` phase runs Prisma migrations automatically on every deploy before the dyno starts.

---

## Commands (Planned)

### Player-Facing

| Command | Description |
|---|---|
| `/matchup <build_a> <build_b>` | Look up the rules for a specific build vs build matchup |
| `/banned-matchups [build]` | List all banned matchups (optionally filtered by build) |
| `/deathmatch <build>` | Show the deathmatch alternatives for a given build |
| `/rules` | Display the general TDL rules |
| `/ladder [page]` | Show current league standings |
| `/player <name>` | Show a player's stats, build(s), and record |
| `/faq [topic]` | Look up FAQ entries |
| `/register <ign> <build>` | Self-register for the league (selects from build list) |

### Match Management

| Command | Description |
|---|---|
| `/queue` | Enter the match queue (FIFO; queue membership hidden from other players) |
| `/im-ready` | Acknowledge a forced match assignment |
| `/report-win <opponent>` | Report a match result (winner initiates) |
| `/report-win-test <opponent>` | Report a result under the test rule (tracked separately) |
| `/confirm-result` | Opponent confirms reported result |
| `/request-mirror <opponent>` | Request a mirror match (both must consent) |

### Mod / Admin

| Command | Description |
|---|---|
| `/refresh-cache [tab]` | Force-refresh sheet cache (all or specific tab) |
| `/admin-set-result <player1> <player2> <winner>` | Override match result |
| `/admin-register <discord_user> <ign> <build>` | Register a player on their behalf |
| `/admin-remove-player <discord_user>` | Remove a player from the league |
| `/admin-view-queue` | View current queue (mod-only; hidden from players) |
| `/admin-warn <discord_user> [reason]` | Manually issue a warning to a player |
| `/admin-clear-warning <discord_user>` | Remove a warning from a player's record |

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

## Key Design Decisions

1. **Google Sheets is the source of truth for rule content only.** Mods update rules directly in the sheet. The bot reads and caches. Player records, match results, warnings, and ladder standings are stored in **PostgreSQL**, not in the sheet.

2. **SQLite is explicitly off the table.** Heroku's ephemeral filesystem destroys SQLite files on every dyno restart. All durable state uses Heroku Postgres.

3. **Build registration uses a fixed autocomplete list, not free text.** This was an explicit design requirement from the brainstorming chat ("choosing from a list of available builds to maintain data integrity"). Free-form build entry breaks matchup automation.

4. **Players may register multiple builds.** When two queued players are matched, the bot selects the "least disadvantaged matchup" from all possible build pairings. The algorithm for this is TBD — see clarifying-questions.md.

5. **Two result recording modes.** Stadium explicitly requested a way to track test-rule match outcomes separately from regular match outcomes. Both flows look the same to players but are stored/counted differently.

6. **Mirror matches require mutual consent.** Stadium confirmed mirrors are allowed but both players must agree. The bot facilitates this via a button-based consent flow.

7. **Matchup rule display shows BOTH sides.** Stadium's intent: when displaying matchup rules for a match (e.g., NvD), show ALL of the Necro's rules AND ALL of the Druid's rules — not just the matchup-specific cell. Exception: for NvT, also append the test rule.

8. **Build name resolution.** Build names should support partial/fuzzy matching and aliases (e.g., "hammerdin" → "Paladin - Hammerdin"). A canonical build list with aliases lives in `src/utils/buildList.ts`.

9. **Matchup lookup is symmetric.** `/matchup Ghost Trapper` and `/matchup Trapper Ghost` should return the same result (check both [A][B] and [B][A] cells in the matrix).

10. **Banned matchup handling.** Before displaying matchup rules, always check whether the matchup is on the banned list and surface that prominently if so.

11. **Deathmatch alternatives.** Each build has up to 5 deathmatch opponents listed. These are drawn from the `Matchups: Deathmatches` sheet tab.

12. **Queue is FIFO and private.** Queue membership is never exposed to other players — only mods can view it via `/admin-view-queue`. This prevents cherry-picking opponents. When a player joins the queue, they are immediately matched with the next player already in queue (if one exists).

13. **Forced match cadence.** Players on the ladder are expected to play approximately every 3 days. A scheduler checks for players whose last match (or queue join) exceeds this window and issues a forced match assignment requiring an "I'm ready" acknowledgment.

14. **Warning system.** Unresponsive players (who fail to acknowledge a forced match) receive a warning stored in Postgres. Reaching the `WARNING_THRESHOLD` (default: 5) triggers automatic removal from the ladder. Mods can manually issue or clear warnings.

15. **Auto-created thread per match.** When two players are matched, the bot creates a private thread in a designated channel, adds both players, and posts the matchup + applicable rules. Requires `MANAGE_THREADS` permission.

16. **Farming cap.** A player cannot be matched against the same opponent more than `FARMING_CAP_MAX` times (default: 2) within a `FARMING_CAP_HOURS` window (default: 24h). This is tracked in Redis with TTL.

---

## Files in This Repo

| File | Purpose |
|---|---|
| `CLAUDE.md` | This file — project context for Claude Code |
| `clarifying-questions.md` | Open questions for Stadium to answer before/during build |
| `architecture.md` | Detailed system architecture and data flow |
| `D2R PvP 1v1 League - Matchups.csv` | Local snapshot of the Matchups sheet tab |
| `General_rules.md` | General league rules (to be filled in) |
| `Discord-group-chat-brainstorming.md` | Discord chat export with feature ideas (to be filled in) |
| `Images/` | Screenshots of the Google Sheet structure |
