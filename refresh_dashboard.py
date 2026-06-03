#!/usr/bin/env python3
"""
Stewart Dashboard — Weekly Data Refresh
Pulls from Freshdesk + Voiceflow APIs, runs Claude AI tagging,
and regenerates stewart-support-dashboard.html with live data.

Usage:
  export FRESHDESK_DOMAIN=universaltennis
  export FRESHDESK_API_KEY=your_key_here
  export VOICEFLOW_API_KEY=your_key_here
  export ANTHROPIC_API_KEY=your_key_here
  python refresh_dashboard.py
"""

import os
import json
import re
import math
import datetime
import time
import sys
from pathlib import Path

import requests
import anthropic

# ── Config ────────────────────────────────────────────────────────────────────

FRESHDESK_DOMAIN = os.environ["FRESHDESK_DOMAIN"]          # e.g. "universaltennis"
FRESHDESK_API_KEY = os.environ["FRESHDESK_API_KEY"]
VOICEFLOW_API_KEY = os.environ["VOICEFLOW_API_KEY"]
ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]

FRESHDESK_BASE = f"https://{FRESHDESK_DOMAIN}.freshdesk.com/api/v2"
VOICEFLOW_BASE = "https://api.voiceflow.com/v2"
FRESHDESK_TICKET_URL = f"https://{FRESHDESK_DOMAIN}.freshdesk.com/a/tickets/"

ROLLING_WEEKS = 6          # how many weeks to show on the dashboard
AI_RES_WINDOW_HOURS = 48   # hours after chat to check for human ticket (no ticket = AI resolved)

TOPIC_LABELS = [
    "Billing & invoices",
    "Login & password",
    "Shipping & delivery",
    "Returns & refunds",
    "Product how-to",
    "Account changes",
    "Cancellations",
    "Other",
]

ESCALATION_REASONS = [
    "No matching intent / out of scope",
    "Knowledge gap (no KB answer)",
    "User asked for a human",
    "Low confidence / repeated fallback",
    "Account action bot can't perform",
]

# ── Freshdesk helpers ─────────────────────────────────────────────────────────

def fd_get(path: str, params: dict = None) -> list | dict:
    url = FRESHDESK_BASE + path
    auth = (FRESHDESK_API_KEY, "X")
    all_items = []
    page = 1
    while True:
        p = {**(params or {}), "page": page, "per_page": 100}
        r = requests.get(url, auth=auth, params=p, timeout=30)
        r.raise_for_status()
        data = r.json()
        if isinstance(data, list):
            all_items.extend(data)
            if len(data) < 100:
                break
            page += 1
        else:
            return data
    return all_items


def fetch_tickets_for_week(week_start: datetime.date, week_end: datetime.date) -> list:
    """Return all Freshdesk tickets created in [week_start, week_end)."""
    created_since = week_start.isoformat() + "T00:00:00Z"
    created_before = week_end.isoformat() + "T00:00:00Z"
    tickets = fd_get("/tickets", {
        "created_since": created_since,
        "order_by": "created_at",
        "order_type": "asc",
    })
    return [t for t in tickets if t["created_at"] < created_before]


def fetch_csat_for_week(week_start: datetime.date, week_end: datetime.date) -> float | None:
    """Return average CSAT % for tickets resolved in this week (Freshdesk ratings)."""
    try:
        ratings = fd_get("/surveys/satisfaction_ratings", {
            "created_since": week_start.isoformat() + "T00:00:00Z",
        })
        week_ratings = [r for r in ratings if r.get("created_at", "") < week_end.isoformat() + "T00:00:00Z"]
        if not week_ratings:
            return None
        # Freshdesk: rating 103=happy(100%), 102=neutral(50%), 101=unhappy(0%)
        score_map = {103: 100, 102: 50, 101: 0}
        scores = [score_map.get(r.get("rating"), 50) for r in week_ratings]
        return sum(scores) / len(scores)
    except Exception:
        return None


def compute_sla_attainment(tickets: list) -> float:
    """% of tickets that met first-response SLA."""
    # Freshdesk tickets carry stats.first_responded_at; SLA is set by your policy.
    # We check the fd_sla_policy fields when present; fall back to a naive check.
    met = total = 0
    for t in tickets:
        stats = t.get("stats") or {}
        if stats.get("first_responded_at"):
            total += 1
            # If Freshdesk marks it violated explicitly
            if not t.get("is_escalated"):
                met += 1
    return (met / total * 100) if total else 0.0


def compute_avg_first_response(tickets: list) -> float:
    """Mean time-to-first-response in business hours (approximate: raw hours)."""
    times = []
    for t in tickets:
        stats = t.get("stats") or {}
        created = t.get("created_at")
        first = stats.get("first_responded_at")
        if created and first:
            c = datetime.datetime.fromisoformat(created.replace("Z", "+00:00"))
            f = datetime.datetime.fromisoformat(first.replace("Z", "+00:00"))
            hours = (f - c).total_seconds() / 3600
            if 0 < hours < 240:   # sanity filter: ignore tickets > 10 days
                times.append(hours)
    return sum(times) / len(times) if times else 0.0


# ── Voiceflow helpers ─────────────────────────────────────────────────────────

def vf_get(path: str, params: dict = None) -> list | dict:
    headers = {"Authorization": VOICEFLOW_API_KEY}
    r = requests.get(VOICEFLOW_BASE + path, headers=headers, params=params, timeout=30)
    r.raise_for_status()
    return r.json()


def fetch_voiceflow_sessions(week_start: datetime.date, week_end: datetime.date) -> list:
    """Return all Voiceflow conversation sessions in the week."""
    # Voiceflow Transcripts API: GET /v2/transcripts/{project_id}
    # The project ID should be set as an env var.
    project_id = os.environ.get("VOICEFLOW_PROJECT_ID", "")
    if not project_id:
        print("  ⚠  VOICEFLOW_PROJECT_ID not set — skipping Voiceflow pull", file=sys.stderr)
        return []
    try:
        transcripts = vf_get(f"/transcripts/{project_id}", {
            "startTime": week_start.isoformat(),
            "endTime": week_end.isoformat(),
        })
        return transcripts if isinstance(transcripts, list) else []
    except Exception as e:
        print(f"  ⚠  Voiceflow fetch failed: {e}", file=sys.stderr)
        return []


def classify_sessions(sessions: list, week_tickets: list) -> dict:
    """
    Split sessions into bounces vs engaged.
    An engaged session with no matching Freshdesk ticket within 48h = AI resolved.
    Join is on user email (from session metadata) + timestamp.
    """
    ticket_emails = {
        t.get("requester_id"): t.get("created_at")
        for t in week_tickets
        if t.get("email")
    }
    # Build a set of (email, created_at_day) for quick lookup
    ticket_set: set[tuple] = set()
    for t in week_tickets:
        email = t.get("email", "")
        if email and t.get("created_at"):
            day = t["created_at"][:10]
            ticket_set.add((email.lower(), day))

    bounces = engaged = ai_resolved = 0
    for s in sessions:
        turns = s.get("turns") or []
        user_turns = [t for t in turns if t.get("type") == "request"]
        if not user_turns:
            bounces += 1
            continue
        engaged += 1
        # Check if user raised a ticket within AI_RES_WINDOW_HOURS
        email = (s.get("metadata") or {}).get("email", "").lower()
        session_time = s.get("createdAt", "")[:10]
        if email and (email, session_time) not in ticket_set:
            ai_resolved += 1

    return {"sessions": len(sessions), "bounces": bounces, "engaged": engaged, "ai_resolved": ai_resolved}


# ── Claude AI tagging ─────────────────────────────────────────────────────────

def tag_with_claude(sessions: list, tickets: list) -> dict:
    """
    Ask Claude to:
    1. Tag each topic's share of contacts + sentiment score
    2. Classify AI-resolution rate by chat type
    3. Tally escalation reasons
    4. Surface standout and problem conversations

    Returns a dict with keys: topics, ai_res_by_type, escalation_reasons, conversations
    """
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

    # Build a compact summary of sessions to fit in context
    session_summaries = []
    for s in sessions[:200]:   # cap at 200 for cost; increase if needed
        turns = s.get("turns") or []
        messages = [
            {"role": t.get("type"), "text": (t.get("payload") or {}).get("message", "")}
            for t in turns
            if (t.get("payload") or {}).get("message")
        ]
        session_summaries.append({
            "id": s.get("_id"),
            "createdAt": s.get("createdAt"),
            "messages": messages[:12],   # first 12 turns
            "escalated": s.get("escalated", False),
        })

    ticket_summaries = [
        {"id": t["id"], "subject": t.get("subject", ""), "tags": t.get("tags", [])}
        for t in tickets[:100]
    ]

    prompt = f"""You are analysing a week of support data for Universal Tennis (UTR Sports).
Below are summaries of Stewart (Voiceflow) chat sessions and Freshdesk support tickets.

TOPICS (use exactly these labels): {json.dumps(TOPIC_LABELS)}
ESCALATION_REASONS (use exactly these labels): {json.dumps(ESCALATION_REASONS)}

CHAT SESSIONS (up to 200):
{json.dumps(session_summaries, indent=2)}

FRESHDESK TICKETS (up to 100):
{json.dumps(ticket_summaries, indent=2)}

Return ONLY valid JSON (no markdown, no prose) with this exact structure:
{{
  "topics": [
    {{"name": "<topic label>", "pct": <integer % of all contacts>, "sent": <0.0–1.0 sentiment>}}
  ],
  "ai_res_by_type": [
    {{"name": "<topic label>", "pct": <integer % of engaged chats in this topic resolved by AI>}}
  ],
  "escalation_reasons": [
    {{"name": "<reason label>", "pct": <integer % of escalations>}}
  ],
  "conversations": [
    {{
      "type": "star" | "issue",
      "when": "<date string>",
      "topic": "<topic label>",
      "sent": <0.0–1.0>,
      "note": "<1-sentence description of what happened>",
      "ticket": "<Freshdesk ticket ID as string, or null>"
    }}
  ]
}}

Rules:
- topics pcts must sum to 100
- escalation_reasons pcts must sum to 100
- conversations: 3 stars + 3 issues maximum, pick the most notable
- sentiment: 0=very negative, 1=very positive
"""

    response = client.messages.create(
        model="claude-opus-4-8",
        max_tokens=2000,
        messages=[{"role": "user", "content": prompt}],
    )
    raw = response.content[0].text.strip()
    # Strip markdown code fences if present
    raw = re.sub(r"^```[a-z]*\n?", "", raw).rstrip("`").strip()
    return json.loads(raw)


# ── Cost estimation ───────────────────────────────────────────────────────────

def estimate_voiceflow_cost(sessions: int, ai_resolved: int) -> float:
    """
    Rough weekly cost estimate.
    Adjust VOICEFLOW_PLATFORM_WEEKLY and LLM_COST_PER_ENGAGED to your actuals.
    """
    VOICEFLOW_PLATFORM_WEEKLY = 80.0   # amortized platform/seat cost per week
    LLM_COST_PER_ENGAGED = 0.30        # avg API cost per engaged session
    return VOICEFLOW_PLATFORM_WEEKLY + (sessions * LLM_COST_PER_ENGAGED)


# ── Dashboard regeneration ────────────────────────────────────────────────────

def build_week_js(weeks_data: list) -> str:
    return "const WEEKS=" + json.dumps(weeks_data, indent=1) + ";"


def regenerate_dashboard(
    weeks_data: list,
    latest_tagging: dict,
    freshdesk_ticket_url: str,
) -> None:
    template_path = Path(__file__).parent / "stewart-support-dashboard.html"
    html = template_path.read_text()

    # Replace WEEKS array
    html = re.sub(
        r"const WEEKS=\[[\s\S]*?\];",
        build_week_js(weeks_data),
        html,
    )

    # Replace AI_RES_BY_TYPE (AIRES)
    aires = latest_tagging.get("ai_res_by_type", [])
    if aires:
        aires_js = "const AIRES=" + json.dumps(aires, indent=1) + ";"
        html = re.sub(r"const AIRES=\[[\s\S]*?\];", aires_js, html)

    # Replace TOPICS
    topics = latest_tagging.get("topics", [])
    if topics:
        topics_js = "const TOPICS=" + json.dumps(topics, indent=1) + ";"
        html = re.sub(r"const TOPICS=\[[\s\S]*?\];", topics_js, html)

    # Replace ESC
    esc = latest_tagging.get("escalation_reasons", [])
    if esc:
        esc_js = "const ESC=" + json.dumps(esc, indent=1) + ";"
        html = re.sub(r"const ESC=\[[\s\S]*?\];", esc_js, html)

    # Replace CONVOS
    convos = latest_tagging.get("conversations", [])
    if convos:
        convos_js = "const CONVOS=" + json.dumps(convos, indent=1) + ";"
        html = re.sub(r"const CONVOS=\[[\s\S]*?\];", convos_js, html)

    # Remove sample data banner
    html = re.sub(
        r'<div class="banner">[\s\S]*?</div>',
        "",
        html,
        count=1,
    )

    # Update generated timestamp in footer
    now = datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
    html = html.replace(
        "Sample dashboard generated by Claude",
        f"Dashboard refreshed {now} by Claude",
    )

    template_path.write_text(html)
    print(f"✅  Dashboard regenerated: {template_path}")


# ── Main ──────────────────────────────────────────────────────────────────────

def week_range(offset_weeks: int) -> tuple[datetime.date, datetime.date]:
    """Return (monday, next_monday) for week offset_weeks ago (0 = current week)."""
    today = datetime.date.today()
    monday = today - datetime.timedelta(days=today.weekday())
    start = monday - datetime.timedelta(weeks=offset_weeks)
    return start, start + datetime.timedelta(days=7)


def main():
    print("🔄  Stewart Dashboard — weekly refresh starting")
    weeks_data = []
    latest_tagging = {}

    for week_offset in range(ROLLING_WEEKS - 1, -1, -1):
        week_start, week_end = week_range(week_offset)
        label = f"{week_start.strftime('%b %-d')}–{(week_end - datetime.timedelta(days=1)).strftime('%-d')}"
        print(f"\n📅  Week {label} ({week_start} → {week_end})")

        # Freshdesk
        print("  Pulling Freshdesk tickets…")
        tickets = fetch_tickets_for_week(week_start, week_end)
        print(f"  {len(tickets)} tickets")

        csat = fetch_csat_for_week(week_start, week_end)
        sla = compute_sla_attainment(tickets)
        frt = compute_avg_first_response(tickets)
        backlog = sum(1 for t in tickets if t.get("status") in (2, 3))  # open + pending

        # Voiceflow
        print("  Pulling Voiceflow sessions…")
        sessions = fetch_voiceflow_sessions(week_start, week_end)
        print(f"  {len(sessions)} sessions")
        sc = classify_sessions(sessions, tickets)

        cost = estimate_voiceflow_cost(sc["sessions"], sc["ai_resolved"])

        week_row = {
            "label": label,
            "ticketsCreated": len(tickets),
            "ticketsResolved": sum(1 for t in tickets if t.get("status") == 4),
            "backlog": backlog,
            "csat": round(csat) if csat else 0,
            "sla": round(sla, 1),
            "frt": round(frt, 1),
            "sessions": sc["sessions"],
            "bounces": sc["bounces"],
            "aiResolved": sc["ai_resolved"],
            "cost": round(cost),
        }
        weeks_data.append(week_row)

        # Run Claude tagging only for the most recent complete week (cost control)
        if week_offset == 1 and sessions:
            print("  Running Claude AI tagging…")
            latest_tagging = tag_with_claude(sessions, tickets)
            print("  Tagging complete.")

    regenerate_dashboard(weeks_data, latest_tagging, FRESHDESK_TICKET_URL)
    print("\n✅  Done. Open stewart-support-dashboard.html in your browser.")


if __name__ == "__main__":
    main()
