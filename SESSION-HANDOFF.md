# CSS Stats Dashboard — Session Handoff

This document captures all the instructions, rules, and current state so the next
session can pick up exactly where we left off.

---

## What this project is

A self-contained CSS (Customer Success & Support) Stats Dashboard for UTR Sports.

**Architecture (data flows in this order):**
```
fetch-css-data.js  →  css-data.json  →  build-css-dashboard.js  →  css-stats-dashboard.html
```
- `fetch-css-data.js` — pulls from Freshdesk, Voiceflow, and Google Sheets; writes `css-data.json`
- `css-data.json` — the data cache (committed to git, acts as historical store)
- `build-css-dashboard.js` — reads the JSON, writes a fully self-contained HTML file (no CDN/internet needed)
- `.github/workflows/refresh-css-dashboard.yml` — runs weekly (Mondays) + manual trigger; runs both scripts and commits the result

**Branch:** all work is on `claude/focused-ptolemy-j6fiib`. The workflow commits refreshed data to `main`.

---

## STANDING RULES (must follow every time)

1. **ONE CHANGE AT A TIME.** Fix one thing, confirm it works, then move to the next.
   Do NOT make multiple changes at once.

2. **I CANNOT regenerate the Freshchat API token.** Never ask me to regenerate,
   refresh, or create a new token. Ever. Work with what we have.

3. **Pull at only 20% of maximum API capacity.** 3 seconds between Freshdesk calls
   (`MIN_SLEEP_MS = 3000`) so we don't conflict with the Stewart bot.

---

## Key business definitions / decisions

- **CSS groups:** General, Campaigns, Bug Captain.
- **Chat tickets** ("Conversation with…") are counted ONLY from the **General** queue.
- **FCR** (First Contact Resolution) = resolved without a customer follow-up reply within 24 hours.
- **FCR — Medium Priority** = same, but only `priority === 2` tickets.
- **FRT** (First Response Time) tracked per priority: Low / Medium / High / Urgent.
- **AI / Voiceflow launched April 2026** — there is nothing to backtrack before that.
  No June 2025 column on the AI Resolution table (not relevant).
- **AI Resolution Rate** = aiResolved / engaged. "Engaged" = not a bounce (bounce = user took no text action).
- **Sessions & AI cost** count **engaged sessions only** (exclude bounces), at **$0.05 per session**.
- **June 2025** is the "prior year" (PY) comparison column for June 2026.
- Medium-priority FCR was NOT used back in June 2025 — fine to leave that blank for PY.

---

## Issues we fixed this session (all on branch, pending validation run)

1. **FRT/FCR showing N/A for ALL months.**
   Cause: Phase 2 stats sweep did one big `updated_since` sweep from June 2025 across
   all groups (20k+ tickets) and hit the page-200 cap before reaching current-month
   tickets. Fix: sweep each target month independently with a `pastEnd` stop condition.

2. **Freshdesk stats going missing whenever something changes.**
   Cause: every run rebuilds `css-data.json` from scratch, so a partial fetch failure
   overwrote good cached data with N/A. Fix: safety net — if a month had cached FD stats
   but the fresh fetch came back empty, restore the FD fields from cache.

3. **AI Resolution Rate stuck at ~0% (June 2026).**
   Cause: `isEscalated()` did a substring match for `freshdesk_create_ticket`, which
   appears in EVERY transcript's available-tools list (151/200 transcripts) — not just
   real escalations. Fix: detect an ACTUAL tool invocation/execution instead
   (`payload.ref.mcpToolName === 'freshdesk_create_ticket'` OR a payload message
   "calling freshdesk_create_ticket").

4. **June 2025 FRT/FCR still missing.**
   Cause: `buildDailyRollups` only created day buckets for the last ~185 days, which
   excludes June 2025 — so PY tickets were fetched but never aggregated. Fix: pass the
   prior-year month as an extra range so its days get bucketed.

5. **June 2026 not populating on the Freshdesk ticket chart.**
   Cause: the chart sourced ticket volume/CSAT ONLY from the Google Sheet, which lags a
   month, so the current month was null. Fix: fall back to the Freshdesk-fetched rollup
   for the current month (same fallback the table already uses).

---

## Current state / what's next

- A **validation workflow run is in progress** on `claude/focused-ptolemy-j6fiib`
  with all 5 fixes above.
- **After it finishes, verify:**
  1. FRT/FCR populate for June 2026, May 2026, YTD, and June 2025
  2. AI Resolution shows realistic numbers for May/June 2026 (not 0%)
  3. June 2026 bar appears on the Freshdesk ticket chart
  4. Paste the Voiceflow diagnostic block (sessions / engaged / aiResolved / cost per month + YTD)

- **Still open (separate, not yet started):**
  - Confirm number of sessions and AI cost are correct for June 2026, May 2026, and YTD
    once the escalation fix lands.

---

## Useful technical notes

- The fetch does a **3-month targeted pull** every run: previous month + current month +
  same-month-last-year (June 2025). Earlier YTD months (Jan–before-prev) are loaded from
  the cached `css-data.json`, and any missing historical month is backfilled automatically.
- First full run after a cache wipe is long (~1–2 hrs) due to backfill; steady-state runs
  are faster.
- Voiceflow: weekly windows deduped by transcript ID (1ms boundary offset to avoid
  double-counting), 90-day lookback (`VF_LOOKBACK_DAYS`).
- A temporary `VF_DIAG` diagnostic was added and then REMOVED this session — it's gone.
- The workflow timeout is 180 minutes.
