# QA Plan — Matchup Tab Removal + Class Rules Refactor

Run this after all 8 implementation steps are complete and the bot is deployed.

---

## Prerequisites

- Bot is running (Heroku dyno up or local `npm run dev`)
- Redis is connected
- Google Sheets service account has read access to the sheet
- You are in the D2R 1v1 League Discord server
- You have a mod role (for cache refresh commands)
- At least two test players are registered with builds from different classes (e.g. a Druid build and a Necromancer build)

---

## Section 1 — Removed Commands (confirm they are gone)

These should return "Unknown command" or simply not appear in Discord's slash command picker.

### 1.1 `/matchup`
**Steps:**
1. In any channel, type `/matchup`
2. Observe the autocomplete picker

**Expected:** Command does not appear in the picker at all.

### 1.2 `/test-rules`
**Steps:**
1. In any channel, type `/test-rules`
2. Observe the autocomplete picker

**Expected:** Command does not appear.

---

## Section 2 — `/rules` (general rules — confirm still working, no class sections)

### 2.1 Basic functionality
**Steps:**
1. Run `/rules`
2. Read through all returned embeds

**Expected:**
- One or more embeds display
- Sections present: General Rules, Map Rules, Item Rules (or similar — whatever is in the `1v1 Rules` tab)
- **No class-specific sections** (no Amazon, Druid, Necromancer headers)
- No error embed

### 2.2 BMPK link renders
**Steps:**
1. In the General Rules section, look for the BMPK reference

**Expected:** Renders as a clickable hyperlink (`[BMPK rules](url)`) not as a raw URL.

---

## Section 3 — `/class-rules` (new command)

### 3.1 No argument — shows all 7 classes
**Steps:**
1. Run `/class-rules` with no argument

**Expected:**
- Multiple embeds returned (one per class, or two if a class overflows)
- All 7 classes present: Amazon, Assassin, Barbarian, Druid, Necromancer, Paladin, Sorceress
- Each embed has the correct class emoji in the title
- No error embed

### 3.2 Single class — no test rules (e.g. Paladin or Barbarian)
**Steps:**
1. Run `/class-rules class:Paladin`

**Expected:**
- Single embed with Paladin emoji in title
- Regular rules listed as bullet points
- **No TEST RULES section** (Paladin has no test rules in sheet)
- Footer: "Use /rules for general league rules."

### 3.3 Single class — with test rules (Druid)
**Steps:**
1. Run `/class-rules class:Druid`

**Expected:**
- Embed contains regular Druid rules as bullet points
- Below a horizontal separator, a **TEST RULES** bold header
- Below that: `• Fire/shaman can stat armageddon but don't use it`
- Correct Druid emoji in title

### 3.4 Single class — with test rules (Necromancer)
**Steps:**
1. Run `/class-rules class:Necromancer`

**Expected:**
- Regular Necromancer rules listed
- TEST RULES section with:
  - `• Nec vs Trap:`
  - `• Necro unhotkey bone armor, cast it once`
  - `• Trapper use shadow warrior`

### 3.5 Single class — with test rules (Assassin)
**Steps:**
1. Run `/class-rules class:Assassin`

**Expected:**
- Regular Assassin rules listed
- TEST RULES section with fire facets and shadow warrior rules

### 3.6 Autocomplete works
**Steps:**
1. Type `/class-rules class:D` and observe autocomplete

**Expected:** Shows `Druid` as a suggestion. Does not show individual build names.

### 3.7 Barbarian (spot-check content)
**Steps:**
1. Run `/class-rules class:Barbarian`

**Expected:**
- Rules include: "Barb makes the game", "No more than 20% life leech", "No more than one poison damage small charm is allowed"
- No TEST RULES section

### 3.8 Sorceress (spot-check content)
**Steps:**
1. Run `/class-rules class:Sorceress`

**Expected:**
- Rules include ES rules (no cold/light/fire resist or absorb gear with ES, etc.)
- "Max 1 hard point into cold mastery" present

---

## Section 4 — Match thread content (most important behavioral change)

### 4.1 Standard queue match — same-class check
**Steps:**
1. Have two registered test players queue (use `/queue` on both accounts, or use `/admin-forcematch` if available)
2. Observe the private match thread that gets created

**Expected thread content (in order):**
1. Match announcement embed: player names, assigned builds, FT4 or FT2, "use `/report-win`"
2. General rules embeds (same content as `/rules`)
3. Class rules embed(s) for Player 1's build class
4. Class rules embed(s) for Player 2's build class — **only if different class from Player 1**

### 4.2 Match with same-class players
**Steps:**
1. Force a match where both players are registered with Assassin builds only

**Expected:** Class rules for Assassin appear **once**, not twice.

### 4.3 Deathmatch pairing
**Steps:**
1. Force a match that results in a DEATHMATCH pairing (e.g. Barbarian vs Hammerdin)

**Expected:**
- Thread announcement says "Match type: Deathmatch (FT2)"
- General rules posted
- Barbarian class rules posted
- Paladin class rules posted
- **No matchup-specific rules** (those are gone)

### 4.4 All-banned override flow
**Steps:**
1. Trigger a match where all build pairings are banned (or simulate via `/admin-forcematch` on two players whose builds are all on the banned list)

**Expected:**
- Thread shows the "All Matchups Banned" embed with Override / Re-queue buttons
- After clicking Override, thread gets the match announcement embed + general rules + class rules (same as 4.1)

---

## Section 5 — Existing commands still work

### 5.1 `/banned-matchups`
**Steps:**
1. Run `/banned-matchups`
2. Run `/banned-matchups build:Necromancer - Bone`

**Expected:** Both work, return correct banned matchup lists.

### 5.2 `/deathmatch`
**Steps:**
1. Run `/deathmatch build:Barbarian - BvC`

**Expected:** Returns the deathmatch alternatives for BvC.

### 5.3 `/ladder`
**Steps:**
1. Run `/ladder`

**Expected:** Standings embed displays correctly.

### 5.4 `/rules` (cross-check with Section 2)
Already covered in Section 2.

---

## Section 6 — Cache management

### 6.1 `/refresh-cache tab:Class Rules`
**Steps:**
1. Run `/refresh-cache tab:Class Rules`

**Expected:**
- Success embed showing "Class Rules — X classes loaded"
- No error

### 6.2 `/refresh-cache` (all tabs)
**Steps:**
1. Run `/refresh-cache` with no argument (refreshes all)

**Expected:**
- Breakdown shows entries for: Banned, Deathmatches, Rules, Class Rules, FAQ, Ladder
- **No "Matchups" or "Test Rules" entries** in the breakdown
- All entries show green check or trash icon (no red X unless Sheets is unreachable)

### 6.3 Cache cold-start for class rules
**Steps:**
1. Run `/refresh-cache tab:Class Rules` to flush
2. Immediately run `/class-rules class:Druid`

**Expected:** Fresh fetch from Sheets — rules display correctly. No error.

---

## Section 7 — Edge cases

### 7.1 Class with no rules at all (hypothetical)
Not expected to occur with current sheet data, but if a class row has an empty column B, the bot should return "*No rules listed.*" rather than erroring.

### 7.2 `/class-rules` with unavailable sheet
**Steps:**
1. Temporarily revoke Sheets API access (or simulate by having Redis cold with Sheets down)

**Expected:** Returns the "Data Temporarily Unavailable" error embed, not an uncaught exception.

### 7.3 Build name → class extraction in thread
**Steps:**
1. Trigger a match involving a build with a compound name like `Amazon - CS Hybrid Bowa`

**Expected:** Thread posts Amazon class rules (not a crash from bad class name parsing).

---

## Sign-off Checklist

| # | Item | Pass? |
|---|---|---|
| 1.1 | `/matchup` command is gone | |
| 1.2 | `/test-rules` command is gone | |
| 2.1 | `/rules` shows general/map/item rules only | |
| 3.1 | `/class-rules` (no arg) shows all 7 classes | |
| 3.3 | Druid test rules appear with separator | |
| 3.4 | Necromancer test rules appear | |
| 4.1 | Thread posts announcement + general + class rules | |
| 4.2 | Same-class match posts class rules once | |
| 5.1 | `/banned-matchups` works | |
| 5.2 | `/deathmatch` works | |
| 6.2 | `/refresh-cache` all — no matchups/test-rules entries | |
