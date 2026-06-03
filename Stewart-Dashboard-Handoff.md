# Stewart × Freshdesk — Dashboard Handoff Brief

**For:** Stewart Product Manager
**From:** VP Customer Support / Head of AI Chatbots
**Purpose:** Hand off a working dashboard prototype + all decisions so you (and your Claude) can take it to live data.

---

## What you're holding

Two files:

1. **`stewart-support-dashboard.html`** — the interactive dashboard prototype. **Double-click it to open in any browser** — no tools needed. It currently runs on **SAMPLE DATA** (clearly banner-flagged) synthesized from our real volumes, so you can judge layout and metrics before we wire anything up.
2. **`Stewart-Dashboard-Handoff.md`** — this file.

**To continue building it:** drag *both* files into Claude (claude.ai or Claude Code) and start with the suggested prompt at the bottom of this doc.

---

## The vision

A single **weekly command center** that unifies **Freshdesk** (human support) and **Voiceflow / Stewart** (the AI bot) into one view for the VP. The whole point: most teams only see half the journey — we own both, so we instrument the full thing and the AI-derived insights on top.

**Our volumes (real):** ~3,000 tickets/week (~430/day, steady) · ~1,100 *engaged* Stewart chats/week · ~140 welcome-only "bounce" sessions/week.

---

## Architecture (decided)

- **Data store:** a single **Google Sheet**, holding a **rolling 6 weeks** of data (older rows auto-pruned, so it stays ~25k rows and fast). No data warehouse — at our volume a Sheet is the correct tool, confirmed by the math.
- **Engine + AI tagging + dashboard:** **Claude does all of it.** Claude reads the Sheet, does the topic/sentiment/AI-resolution/escalation tagging itself (no Make.com, no separate AI tool), writes results back, and regenerates this dashboard.
- **Cadence:** refreshed **weekly**. Honest caveat: Claude isn't a 24/7 server — the dashboard is *regenerated on a weekly schedule* (or on demand), not a live always-on URL. The VP reviews it and asks questions conversationally against that week's data.
- **Storage note:** keep one summary row per conversation + the flagged ones, and **link back** to Voiceflow/Freshdesk for full transcripts. Don't re-store raw transcripts — that's what would break the Sheet.

---

## What's on the dashboard

**Executive snapshot (per selected week):** AI Resolution · CSAT · SLA Attainment · Avg First Response · Tickets Created · Stewart Bounce Rate. Week selector top-right re-cuts these.

**Stewart cost:** last-7-days spend, 6-week weekly average, cost-over-time chart, and cost per AI resolution vs ~$6/human ticket.

**AI Resolution by chat type:** % of each topic Stewart resolves with no human (password 78% → cancellations 28%). High-volume + low-resolution = automation priorities.

**Ticket volume (Freshdesk):** daily volume (6 wks), created vs resolved + backlog, volume by topic.

**AI-derived insights:** top contact topics (colored by sentiment), and why Stewart escalates (root-cause from transcripts).

**Automation roadmap:** ranked by weekly volume — gap, current AI-res %, recommended build, effort (S/M/L), projected $ impact.

**Conversations worth reading:** ★ standouts *and* ⚠ problems, with clickable ticket links.

---

## Metric definitions (locked)

- **AI Resolution** — engaged chats Stewart resolved with no human ticket within 48h, net of repeat contacts. Bounces excluded from denominator.
- **CSAT** — Freshdesk post-ticket rating + Stewart in-chat survey. **Excludes Voiceflow auto-evals** (we don't trust them).
- **SLA Attainment** — % answered within first-response SLA: Urgent ≤1h / High ≤4h / Normal ≤8h / Low ≤24h (business hours). *Sample policy — set to ours.*
- **Avg First Response** — mean time to first agent reply, business hours (Freshdesk).
- **Stewart Bounce Rate** — welcome-only sessions (user never spoke) ÷ all sessions. Kept separate so it never inflates AI Resolution.
- **Stewart Cost** — total operating cost: Voiceflow platform (amortized) + LLM/API usage + integration calls.

---

## Decisions already made (don't relitigate)

- ❌ **No "containment" metric anywhere** — not useful to us. We use **AI Resolution** instead.
- ✅ Renamed "True Deflection" → **AI Resolution** throughout.
- ❌ Removed the bot→human handoff funnel — replaced with AI-Resolution-by-type.
- ✅ CSAT comes from Freshdesk + in-chat survey, **not** Voiceflow evals.
- ✅ Cost is shown as **spend**, not "savings."
- ✅ Definitions must be visible on the dashboard (done: definitions card + hover tooltips).
- ✅ Flag **both** amazing and problem conversations.

---

## What's real vs. placeholder

- **All numbers are SAMPLE** until live data is connected.
- Ticket links use a placeholder domain `yourco.freshdesk.com` — **swap in our real Freshdesk subdomain.**
- Transcript links are stubs until Voiceflow is connected.
- **Open question from the VP:** we removed a "~86% of demand never touches the bot" stat when the funnel was cut. Decide whether to bring it back as a single headline tile — it may be the biggest strategic signal we have.

---

## Next steps (this is "step 2")

1. **Confirm** the ~86%-bypass stat decision above.
2. **Pick the data route:**
   - **API keys (most hands-off):** provide Freshdesk + Voiceflow API keys once → Claude pulls weekly automatically.
   - **Weekly CSV:** export from each tool weekly into the shared folder → Claude reads those. No credentials.
3. **Connect & populate** the Google Sheet (rolling 6 weeks, 42-day prune).
4. **Set the real Freshdesk subdomain** for ticket links.
5. **Wire the weekly auto-refresh** (scheduled run that rebuilds the dashboard each week).

**Technical pointers for whoever connects data:**
- Freshdesk REST API (tickets, satisfaction ratings, agents) → daily rollups + flagged tickets.
- Voiceflow Transcripts + Analytics APIs → per-conversation rows; Claude tags topic/sentiment/AI-resolution/escalation reason.
- **Join** Stewart chats to tickets by **email + timestamp** (v1, no engineering); later pass the Voiceflow conversation ID into a Freshdesk custom field for an exact match.

---

## Suggested first prompt for your Claude

> *"I'm the PM for Stewart, our Voiceflow bot. Attached are a dashboard prototype (`stewart-support-dashboard.html`) and a handoff brief (`Stewart-Dashboard-Handoff.md`). Read the brief first — it has all the decisions and definitions. The dashboard runs on sample data. Help me take it to live data: start with the 'Next steps' section. Don't change the locked decisions."*
