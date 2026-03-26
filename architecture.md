# Bot Architecture & Data Flow

## System Diagram

```
Discord Users / Mods
        │
        │ slash commands / interactions
        ▼
┌─────────────────────────────────────────┐
│            discord.js Bot               │
│                                         │
│  ┌──────────┐   ┌────────────────────┐  │
│  │ Commands │──▶│   Services Layer   │  │
│  │ Handlers │   │                    │  │
│  └──────────┘   │  ┌──────────────┐  │  │
│                 │  │MatchupService│  │  │
│  ┌──────────┐   │  ├──────────────┤  │  │
│  │  Events  │   │  │LadderService │  │  │
│  │ Handlers │   │  ├──────────────┤  │  │
│  └──────────┘   │  │ RulesService │  │  │
│                 │  └──────┬───────┘  │  │
│                 └─────────┼──────────┘  │
└───────────────────────────┼─────────────┘
                            │
              ┌─────────────┴─────────────┐
              │                           │
              ▼                           ▼
   ┌─────────────────┐         ┌─────────────────┐
   │   Redis Cache   │         │  Google Sheets  │
   │   (ioredis)     │◀────────│     API v4      │
   │                 │  writes │                 │
   │  - matchups     │  on miss│  - Matchups tab │
   │  - banned       │         │  - Banned tab   │
   │  - deathmatches │         │  - Deathmatches │
   │  - rules        │         │  - TDL Rules    │
   │  - ladder       │         │  - Ladder       │
   │  - faq          │         │  - Questions    │
   └─────────────────┘         │                 │
                               └─────────────────┘
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

## Ladder Write Flow (Pending Q11 Answer)

**Option A — Bot writes to sheet:**
```
/report-win @opponent
    │
    ▼
Opponent confirms (button interaction, 24h window)
    │
    ▼
SheetsService.updateLadder(winner, loser)  ──▶ Sheets API write
    │
    ▼
CacheService.invalidate("d2r:ladder")
    │
    ▼
Announce result in #results channel
```

**Option B — Mods write to sheet, bot reads:**
```
Mod updates Ladder tab in Google Sheets
    │
    ▼
Bot detects change on next cache refresh (TTL expiry)
OR
Mod runs /refresh-cache ladder
    │
    ▼
Bot posts updated ladder embed to #ladder channel
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
