# Google Sheets Data Reference

This documents the structure of the backing Google Sheet as observed from the CSV export and screenshots. Update this file as the sheet evolves.

---

## Sheet Tabs

| Tab | Status | Notes |
|---|---|---|
| Matchups | Documented | 26×26 build matrix |
| Banned matchups | Documented | Build pairs with banned combinations |
| Matchups: Deathmatches | Documented | Per-build deathmatch alternatives (up to 5) |
| TDL Rules | Unknown structure | See clarifying-questions.md Q3 |
| Questions | Unknown structure | See clarifying-questions.md Q4 |
| Ladder | Unknown structure | See clarifying-questions.md Q2 |
| DFC | Not used by this bot — disregard | N/A |

---

## Matchups Tab

**Structure:** Row = Your Build, Column = Opponent's Build (header row 1, header col A)

**Cell content:** Free-form text listing the rules that apply to YOUR build in that matchup. Some cells are empty (no special rules).

**Lookup logic:** To get full rules for a match between BuildA and BuildB:
- Read cell [BuildA row][BuildB col] → BuildA's rules
- Read cell [BuildB row][BuildA col] → BuildB's rules
- Present both sides in the embed

**Known builds (column/row order from CSV):**
```
1.  Amazon - CS Hybrid Bowa
2.  Amazon - CS Zon
3.  Amazon - Telebow
4.  Amazon - Walkbow
5.  Assassin - Ghost
6.  Assassin - Hybrid
7.  Assassin - Spider
8.  Assassin - Trapper
9.  Barbarian - BvA
10. Barbarian - BvC
11. Barbarian - Throw/WW Hybrid
12. Druid - Fire Druid
13. Druid - Shaman
14. Druid - Windy
15. Necromancer - Bone
16. Paladin - Charger
17. Paladin - Hammerdin
18. Paladin - T/V
19. Paladin - V/C
20. Paladin - V/T
21. Sorceress - Cold ES
22. Sorceress - Cold Vita
23. Sorceress - Fire ES
24. Sorceress - Fire Vita
25. Sorceress - Lite ES
26. Sorceress - Lite Vita
```

---

## Banned Matchups Tab

**Structure (from screenshot):**

| Column A | Column B | Column C | Column D | Column E | Column F |
|---|---|---|---|---|---|
| Build | Banned | Banned | Banned | Banned | Banned |
| Amazon - CS Hybrid Bowa | Paladin - Charger | Paladin - T/V | Paladin - V/C | Paladin - V/T | |
| Amazon - CS Zon | Paladin - Charger | Paladin - T/V | Paladin - V/C | Paladin - V/T | |
| Amazon - Telebow | Paladin - Charger | Paladin - T/V | Paladin - V/C | Paladin - V/T | |
| Amazon - Walkbow | Paladin - Charger | Paladin - T/V | Paladin - V/C | Paladin - V/T | |
| Sorceress - Cold ES | Necromancer - Bone | Necromancer - Bone | Necromancer - Bone | Necromancer - Bone | Necromancer - Bone |
| Sorceress - Fire ES | Necromancer - Bone | Necromancer - Bone | Necromancer - Bone | Necromancer - Bone | Necromancer - Bone |
| Sorceress - Lite ES | Necromancer - Bone | Necromancer - Bone | Necromancer - Bone | Necromancer - Bone | Necromancer - Bone |
| Necromancer - Bone | Sorceress - Cold ES | Sorceress - Fire ES | Sorceress - Lite ES | | |
| Paladin - Charger | Amazon - CS Hybrid | Amazon - CS Zon | Amazon - Telebow | Amazon - Walkbow | |
| Paladin - T/V | Amazon - CS Hybrid | Amazon - CS Zon | Amazon - Telebow | Amazon - Walkbow | |
| Paladin - V/C | Amazon - CS Hybrid | Amazon - CS Zon | Amazon - Telebow | Amazon - Walkbow | |
| Paladin - V/T | Amazon - CS Hybrid | Amazon - CS Zon | Amazon - Telebow | Amazon - Walkbow | |

**Note:** Bans are symmetric (if A bans B, B bans A). The sheet lists both directions explicitly.

---

## Matchups: Deathmatches Tab

**Structure:** Row = Build, Columns B–F = Deathmatch 1 through 5

**Sample data (from screenshot):**

| Build | DM 1 | DM 2 | DM 3 | DM 4 | DM 5 |
|---|---|---|---|---|---|
| Amazon - CS Hybrid Bowa | Paladin - T/V | Paladin - V/C | Paladin - V/T | Sorceress - Cold ES | Assassin - Trapper |
| Amazon - CS Zon | Paladin - T/V | Paladin - V/C | Paladin - V/T | Sorceress - Cold ES | Assassin - Trapper |
| Amazon - Telebow | Paladin - T/V | Paladin - V/C | Paladin - V/T | | |
| Amazon - Walkbow | Paladin - T/V | Paladin - V/C | Paladin - V/T | | |
| Assassin - Ghost | Paladin - V/T | | | | |
| Assassin - Trapper | Necromancer - Bone | | | | |
| Barbarian - BvA | Paladin - Charger | Paladin - Hammerdin | Paladin - T/V | Paladin - V/C | Paladin - V/T |
| Barbarian - BvC | Paladin - Charger | Paladin - Hammerdin | Paladin - T/V | Paladin - V/C | Paladin - V/T |
| Barbarian - Throw/WW Hybrid | Paladin - Charger | Paladin - Hammerdin | Paladin - T/V | Paladin - V/C | Paladin - V/T |
| Druid - Fire Druid | Amazon - Telebow | Amazon - Walkbow | | | |
| Druid - Windy | Sorceress - Fire ES | Amazon - CS Zon | Amazon - Telebow | Amazon - Walkbow | Amazon - CS Hybrid Bowa |
| Necromancer - Bone | Sorceress - Cold ES | Sorceress - Fire ES | Sorceress - Lite ES | Amazon - CS Zon | |
| Paladin - Charger | Necromancer - Bone | | | | |
| Paladin - Hammerdin | Assassin - Trapper | | | | |
| Sorceress - Cold ES | Amazon - CS Zon | Druid - Windy | | | |
| Sorceress - Cold Vita | Amazon - CS Zon | Druid - Windy | | | |
| Sorceress - Fire ES | Amazon - CS Zon | | | | |
| Sorceress - Fire Vita | Amazon - CS Zon | | | | |
| Sorceress - Lite ES | Amazon - CS Zon | | | | |
| Sorceress - Lite Vita | Amazon - CS Zon | | | | |

---

## Known Build Aliases (for autocomplete / fuzzy matching)

| Alias | Canonical Name |
|---|---|
| hammerdin, hdin | Paladin - Hammerdin |
| charger, chargedin | Paladin - Charger |
| tv, t/v | Paladin - T/V |
| vc, v/c | Paladin - V/C |
| vt, v/t | Paladin - V/T |
| ghost, ghostsin | Assassin - Ghost |
| trapper, trapsin | Assassin - Trapper |
| hybrid, hybsin | Assassin - Hybrid |
| spider, spidersin | Assassin - Spider |
| windy, winddruid | Druid - Windy |
| shaman | Druid - Shaman |
| firedruid, fd | Druid - Fire Druid |
| bone, necro, boner | Necromancer - Bone |
| bva | Barbarian - BvA |
| bvc | Barbarian - BvC |
| throwbarb, wwbarb, throwww | Barbarian - Throw/WW Hybrid |
| cszon, java | Amazon - CS Zon |
| telebow | Amazon - Telebow |
| walkbow | Amazon - Walkbow |
| cshybrid, hybowa | Amazon - CS Hybrid Bowa |
| coldvita, cv | Sorceress - Cold Vita |
| coldes, ces | Sorceress - Cold ES |
| firevita, fv | Sorceress - Fire Vita |
| firees, fes | Sorceress - Fire ES |
| litevita, lv | Sorceress - Lite Vita |
| litees, les | Sorceress - Lite ES |
