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
| Cache | Redis (ioredis) |
| Build | tsc / ts-node-dev for dev |
| Env management | dotenv |

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

## Redis Caching Strategy

- **All sheet data should be cached in Redis** to avoid API rate limits and reduce latency
- Cache TTL should be configurable per tab type:
  - Rules/matchups (rarely changes): long TTL (e.g., 1 hour or until manually invalidated)
  - Ladder (changes on every match result): short TTL or invalidate on write
- Provide a mod-only `/refresh-cache` command to force-refresh all or specific tabs
- Cache keys should be namespaced: `d2r:matchups:<build_a>:<build_b>`, `d2r:banned:...`, etc.

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
    ladder.ts         # Ladder read/write logic
  utils/
    buildList.ts      # Canonical list of builds + aliases
    formatters.ts     # Discord embed builders, message formatters
  types/
    index.ts          # Shared TypeScript types/interfaces
  config.ts           # Env var loading and validation
  index.ts            # Entry point — registers commands, starts bot
```

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
| `/queue` | Enter the match queue |
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
CACHE_TTL_RULES=3600        # seconds
CACHE_TTL_LADDER=60         # seconds
NODE_ENV=development
```

---

## Key Design Decisions

1. **Google Sheets is the source of truth, not the database.** Mods update rules directly in the sheet. The bot reads and caches. The bot does NOT write rule data back to the sheet (only ladder results, pending Stadium's confirmation — see clarifying-questions.md).

2. **Build registration uses a fixed autocomplete list, not free text.** This was an explicit design requirement from the brainstorming chat ("choosing from a list of available builds to maintain data integrity"). Free-form build entry breaks matchup automation.

3. **Players may register multiple builds.** When two queued players are matched, the bot selects the "least disadvantaged matchup" from all possible build pairings. The algorithm for this is TBD — see clarifying-questions.md.

4. **Two result recording modes.** Stadium explicitly requested a way to track test-rule match outcomes separately from regular match outcomes. Both flows look the same to players but are stored/counted differently.

5. **Mirror matches require mutual consent.** Stadium confirmed mirrors are allowed but both players must agree. The bot facilitates this via a button-based consent flow.

6. **Matchup rule display shows BOTH sides.** Stadium's intent: when displaying matchup rules for a match (e.g., NvD), show ALL of the Necro's rules AND ALL of the Druid's rules — not just the matchup-specific cell. Exception: for NvT, also append the test rule.

7. **Build name resolution.** Build names should support partial/fuzzy matching and aliases (e.g., "hammerdin" → "Paladin - Hammerdin"). A canonical build list with aliases lives in `src/utils/buildList.ts`.

8. **Matchup lookup is symmetric.** `/matchup Ghost Trapper` and `/matchup Trapper Ghost` should return the same result (check both [A][B] and [B][A] cells in the matrix).

9. **Banned matchup handling.** Before displaying matchup rules, always check whether the matchup is on the banned list and surface that prominently if so.

10. **Deathmatch alternatives.** Each build has up to 5 deathmatch opponents listed. These are drawn from the `Matchups: Deathmatches` sheet tab.

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
