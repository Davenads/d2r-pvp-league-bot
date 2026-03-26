# Clarifying Questions for Stadium

These need to be answered before or during development to avoid building assumptions that need to be unwound later. Items marked ✅ are answered from the brainstorming chat.

---

## Google Sheets Structure

**Q1.** ✅ ~~What does the DFC tab stand for?~~ — DFC tab is disregarded; not used by this bot.

**Q2.** Does the **Ladder** tab have a fixed column structure we can rely on? (e.g., Rank | Player | IGN | Build | W | L | W% | Points?) Please share the column headers.

**Q3.** Does the **TDL Rules** tab have a structured format (rows/columns) or is it free-form text in a single cell/column?

**Q4.** Does the **Questions** tab contain pre-written FAQ entries, or is it a place where players post questions for mods to answer? Is it structured as Q&A pairs?

**Q5.** In the **Matchups** matrix, some cells appear to be empty — does an empty cell mean "no special rules apply" or "this matchup hasn't been defined yet"?

---

## Build List & Registration

**Q6.** ✅ Players register by selecting from a fixed build list (not free text). The canonical list is the 26 builds currently in the sheet. Are there any additions or removals before launch?

**Q7.** Can a player register **multiple builds**, or exactly one build per season?
  - If multiple: is there a cap (e.g., max 2 or 3 builds)?
  - If multiple: when they're matched in queue, does the bot pick the least-disadvantaged pairing from their available builds, or does the player choose at match time?

**Q8.** Is there a registration window (sign-ups open for a set period at season start), or is registration always open?

**Q9.** The earlier build discussion included "Paladin - Mage" and "Paladin - Murderdin" — the final sheet has "Paladin - T/V" instead. Can you confirm T/V = Tesladin/Vindicator (or similar)? Any other build names that need clarification?

---

## Matchup Selection & Queue

**Q10.** How does the **queue** system work? Specifically:
  - Is it a general pool queue (first two available players get matched)?
  - Or a challenge system (Player A challenges Player B specifically)?
  - Or both?

**Q11.** Stadium mentioned the bot should pick the "least disadvantaged matchup" between two players' builds. How should disadvantage be quantified? Options:
  - a) Use the matchup win-rate data from the DFC/TDL historical stats
  - b) Mods manually assign a score or tier to each matchup in the sheet
  - c) Treat all non-banned matchups as equal, and selection is random
  - d) Something else?

**Q12.** For **mirror matches** (same build vs same build): the rule is both players must consent. Should the bot prompt for consent via a button interaction, or is it handled outside the bot?

---

## Match Rules & Display

**Q13.** Stadium said to show ALL rules for both classes in a matchup (not just the cell-specific rules). For example, Necro vs Druid shows all Necro rules + all Druid rules. Is the intent that each build has a "base ruleset" column (e.g., Necro-vs-anyone rules) in the sheet, or should the bot aggregate from the row entries?

**Q14.** The **test rule** for NvT (Necro vs Trapper): what exactly is the test rule? Is it captured in the sheet, or does it need to be added? Stadium wanted match results under this rule tracked separately.

**Q15.** What is the match format — best of 1, best of 3, best of 5? Does this differ for deathmatch vs regular season?

---

## Deathmatch

**Q16.** What is a "Deathmatch" in the context of this league? When does it get triggered (e.g., a banned matchup becomes a deathmatch, end-of-season playoffs, player requests it)?

**Q17.** The Deathmatches tab shows up to 5 alternative opponents per build. When a deathmatch is triggered, who picks from the list — the player, the opponent, or is it automated?

---

## Match Result Reporting

**Q18.** Should the bot **write results to the Google Sheet** (Ladder tab), or should mods update the sheet manually and the bot reads/caches it?

**Q19.** Result confirmation flow — when the winner reports, does the opponent need to confirm within a time window, or is the report immediately recorded?

**Q20.** What happens in a disputed result — is there a mod-review channel, or does Stadium handle disputes directly in DMs?

---

## Discord Server Structure

**Q21.** What channels are planned/exist for the bot to interact with? For example:
- `#matchup-lookup`
- `#results`
- `#ladder`
- `#queue`
- `#announcements`
- `#admin-commands`

**Q22.** Should certain commands be restricted to specific channels?

**Q23.** What Discord roles should the bot recognize (e.g., `Mod`, `Registered Player`)? What bot permissions does each role get?

---

## Notifications & Announcements

**Q24.** Should the bot auto-announce anything? (e.g., match results to #results, ladder updates, season start/end)

**Q25.** Should the bot DM players for pending confirmations or queue status?

---

## Technical / Deployment

**Q26.** Where will this bot be hosted? (VPS, Railway, Heroku, local machine, other?)

**Q27.** Will there be a dev/staging bot (separate Discord app + test server) alongside the production bot?

**Q28.** The Google Sheet was set up by sweatyBetty — do you (Stadium) have editor access and is the sheet structure considered final, or still being adjusted?

**Q29.** Do you have a Redis instance available, or does that need to be provisioned? (Redis Cloud free tier, Upstash, and self-hosted are all options.)
