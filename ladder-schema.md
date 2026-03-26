# Ladder Tab — Recommended Column Schema

## Recommended Column Order

| Col | Label | Type | Notes |
|---|---|---|---|
| A | `Rank` | Number (formula) | Auto-calculated by Points desc, then W% desc as tiebreaker |
| B | `Discord_Username` | Text | e.g. `Stadium` — used as the bot's primary lookup key |
| C | `Discord_ID` | Number | Snowflake ID — bot uses this internally; more reliable than username |
| D | `IGN` | Text | In-game name |
| E | `Build` | Text | Primary registered build (canonical name e.g. `Paladin - Hammerdin`) |
| F | `Build_2` | Text | Secondary build if multi-build registration is allowed (leave blank if unused) |
| G | `W` | Number | Regular season wins |
| H | `L` | Number | Regular season losses |
| I | `W%` | Percentage (formula) | `=IF(G+H=0, 0, G/(G+H))` |
| J | `Points` | Number | League points — formula or mod-entered depending on scoring system |
| K | `TR_W` | Number | Test Rule wins (NvT test rule matches only) |
| L | `TR_L` | Number | Test Rule losses |
| M | `TR_W%` | Percentage (formula) | `=IF(K+L=0, 0, K/(K+L))` |
| N | `DM_W` | Number | Deathmatch wins |
| O | `DM_L` | Number | Deathmatch losses |
| P | `Status` | Text | `Active` / `Inactive` / `DQ` |
| Q | `Last_Match` | Date | Date of most recent result (any type) |
| R | `Registered` | Date | Registration date |
| S | `Notes` | Text | Mod-use only — disputes, flags, off-meta build notes |

---

## Rationale by Column Group

### Identity (A–F)
- **Rank** as a formula keeps the sheet self-maintaining; mods don't manually renumber
- **Discord_ID** (snowflake) is the canonical key the bot uses — usernames can change, IDs don't
- **IGN** separate from Discord handle since players often go by different names in-game
- **Build_2** is a single extra column for now; if multi-build grows, it can expand but keeping it flat is simpler for sheet reads than a separate registration tab

### Match Record (G–J)
- **W/L split** rather than a single "matches played" + W% so both raw numbers are always visible and independently writable
- **W%** as a formula column means the bot never needs to compute it — just reads the cell
- **Points** column left flexible: could be a formula (`=G*3 - L`) or manually entered by mods — decide this based on the scoring system (see clarifying-questions.md Q2)

### Test Rule (K–M)
Stadium explicitly requested separate tracking for NvT matches played under the test rule, to evaluate whether the rule is balanced (targeting 50/50). Keeping TR stats in their own columns means:
- The bot posts regular stats to `/ladder` by default
- Mods can pull TR_W% at season end to judge if the test rule should become permanent

### Deathmatch (N–O)
Deathmatch results are functionally different from regular season matches (they can involve builds that are normally banned against each other). Separating them avoids skewing the regular season W%.

### Admin (P–S)
- **Status** lets the bot filter out `Inactive`/`DQ` players from the live ladder display without deleting their row
- **Last_Match** date helps mods identify inactive players; also useful for inactivity DQ rules if the league adopts them
- **Notes** is mod-only context (e.g. "playing Charger — treat as V/C for matchup purposes if using Grief")

---

## Bot Read Pattern

The bot reads the Ladder tab as a flat array starting at row 2 (row 1 = headers). Column order must match the schema above exactly, or the bot config needs updating to map by header name.

**Recommended:** read by header name (not column index) so sheet columns can be reordered without breaking the bot.

```
GET Ladder!A1:S  →  parse header row → map each data row to LadderEntry object
```

**LadderEntry type:**
```typescript
interface LadderEntry {
  rank: number;
  discordUsername: string;
  discordId: string;
  ign: string;
  build: string;
  build2?: string;
  wins: number;
  losses: number;
  winPct: number;
  points: number;
  trWins: number;
  trLosses: number;
  trWinPct: number;
  dmWins: number;
  dmLosses: number;
  status: 'Active' | 'Inactive' | 'DQ';
  lastMatch: string;
  registered: string;
  notes?: string;
}
```

---

## Bot Write Pattern (if bot writes results)

On match result confirmed, bot writes to **W or L column only** for both players using the Discord_ID as the lookup key:

```
Find row where Discord_ID = winnerId  →  increment W (col G)
Find row where Discord_ID = loserId   →  increment L (col H)
Update Last_Match (col Q) for both
```

For test rule matches: increment TR_W (col K) / TR_L (col L) instead of G/H.
For deathmatch: increment DM_W (col N) / DM_L (col O).

The `Rank`, `W%`, `TR_W%` formula columns update automatically.

---

## Notes on Scoring / Points (Pending Q2)

Until Stadium confirms the scoring system, leave `Points` as a manually updated column. Common options:

| System | Formula |
|---|---|
| Win = 1pt | `=G` |
| Win = 3pt, Loss = 0 | `=G*3` |
| Win = 3pt, DM Win = 5pt | `=G*3 + DM_W*5` |
| ELO | Requires bot-side calculation — cannot be a simple sheet formula |
