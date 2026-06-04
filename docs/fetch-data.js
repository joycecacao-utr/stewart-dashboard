#!/usr/bin/env node
// fetch-data.js — runs in GitHub Actions, writes docs/data.json
// Node 20+ (built-in fetch). Run: node docs/fetch-data.js
//
// Emits DAILY ROLLUPS (one row per day, raw numerators/denominators) so the
// browser can aggregate any date range — 24h / 7d / 30d / quarter / year /
// custom — and compute ratios live from a single dataset.

import { writeFileSync } from 'fs';
import { join } from 'path';

// ─── CONFIG ────────────────────────────────────────────────────────────────
const FD_KEY      = process.env.FRESHDESK_KEY;
const VF_KEY      = process.env.VOICEFLOW_KEY;
const FD_DOMAIN   = process.env.FRESHDESK_DOMAIN || 'universaltennis';
const VF_PROJECT  = '69ebdbdd003c5c7a49123a84';

const STEWART_TAG       = 'Stewart_AI';
const GENERAL_GROUP     = 'General';
const COST_PER_SESSION  = 0.05;   // $/session — update to match your Voiceflow bill
const HUMAN_TICKET_COST = 6.00;   // fully-loaded cost per human-handled ticket, for roadmap ROI
const LOOKBACK_DAYS     = 90;     // how far back to build daily rollups (caps all ranges)
const FETCH_BUFFER_DAYS = 5;      // pull a little extra so resolved/backlog at the edge is accurate

// SLA first-response thresholds (calendar hours). Update to match your Freshdesk policy.
// Freshdesk priority: 1=Low, 2=Medium/Normal, 3=High, 4=Urgent
const SLA_HOURS = { 1: 24, 2: 8, 3: 4, 4: 1 };

const ESCALATION_KW = [
  'agent', 'human', 'transfer', 'escalat', 'handoff',
  'live chat', 'representative', 'speak to', 'talk to someone',
];

// Categories: keywords matched against ticket subject + tags + first VF user message
const CATEGORIES = {
  'Account / Login':    { kw: ['account', 'login', 'password', 'sign in', 'access', 'locked', 'forgot'], color: '#4f46e5' },
  'Ranking / UTR':      { kw: ['ranking', 'rank', 'utr', 'rating', 'score', 'algorithm'],                color: '#0891b2' },
  'Tournament':         { kw: ['tournament', 'event', 'register', 'sign up', 'draw', 'wildcard'],        color: '#16a34a' },
  'Billing':            { kw: ['billing', 'payment', 'charge', 'refund', 'invoice', 'money', 'fee'],     color: '#dc2626' },
  'Technical Issue':    { kw: ['error', 'bug', 'not working', 'broken', 'crash', 'loading', 'slow'],     color: '#d97706' },
  'Match Results':      { kw: ['match', 'result', 'score', 'win', 'loss', 'played', 'dispute'],          color: '#7c3aed' },
  'Profile / Settings': { kw: ['profile', 'photo', 'name', 'update', 'settings', 'edit'],               color: '#0d9488' },
};
const CATEGORY_LIST = [
  ...Object.entries(CATEGORIES).map(([name, d]) => ({ name, color: d.color })),
  { name: 'General Inquiry', color: '#94a3b8' },
];

// Escalation root-cause buckets — order matters (first match wins)
const ESC_REASONS = [
  { name: 'User asked for a human',            kw: ['human', 'agent', 'person', 'representative', 'speak to', 'talk to'] },
  { name: 'No matching intent / out of scope', kw: ["don't understand", "not sure", "can't help with that", "outside", "don't have info", "not familiar"] },
  { name: 'Knowledge gap (no KB answer)',      kw: ["don't know", "can't find", "no information", "don't have details", "more info"] },
  { name: "Account action bot can't perform",  kw: ["can't do that", "unable to", "not able to", "manual process", "team will"] },
  { name: 'Repeated fallback',                 kw: [] }, // detected structurally
];
const ESC_REASON_NAMES = ESC_REASONS.map(r => r.name);

// Static automation roadmap — update based on your real data insights
const ROADMAP = [
  { gap: 'Ranking result questions',        volWeek: 85, aiResNow: '41%', build: 'UTR algorithm explainer + FAQ flow',          effort: 'S', impact: '~65 tickets/wk → ~$20k/yr' },
  { gap: 'Account login / access reset',    volWeek: 72, aiResNow: '63%', build: 'Guided self-service reset flow',               effort: 'S', impact: '~45 tickets/wk → ~$14k/yr' },
  { gap: 'Tournament registration issues',  volWeek: 58, aiResNow: '38%', build: 'Tournament lookup + registration API',         effort: 'M', impact: '~36 tickets/wk → ~$11k/yr' },
  { gap: 'Billing & subscription questions',volWeek: 47, aiResNow: '29%', build: 'Billing API integration + guided flow',        effort: 'M', impact: '~28 tickets/wk →  ~$9k/yr' },
  { gap: 'Match result disputes',           volWeek: 31, aiResNow:   '—', build: 'Match result lookup + dispute escalation flow', effort: 'L', impact: '~20 tickets/wk →  ~$6k/yr' },
];

// ─── HELPERS ────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dayKey = v => { const d = new Date(v); return isNaN(d) ? null : d.toISOString().slice(0, 10); };

function daysAgoISO(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

// ─── FRESHDESK ──────────────────────────────────────────────────────────────
const FD_AUTH = () => 'Basic ' + Buffer.from(`${FD_KEY}:X`).toString('base64');

async function fdGet(path, params = {}) {
  const url = new URL(`https://${FD_DOMAIN}.freshdesk.com/api/v2/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { headers: { Authorization: FD_AUTH() } });
    if (res.status === 429) {                         // rate limited — honor Retry-After
      const wait = (+(res.headers.get('retry-after') || 2) + 1) * 1000;
      console.warn(`  rate limited on ${path}, waiting ${wait / 1000}s…`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`Freshdesk ${path}: HTTP ${res.status}`);
    return res.json();
  }
  throw new Error(`Freshdesk ${path}: rate-limited after retries`);
}

// Simple bounded pagination (for small endpoints like satisfaction_ratings)
async function fdGetAll(path, params = {}, maxPages = 25) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await fdGet(path, { ...params, page, per_page: 100 });
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    if (data.length < 100) break;
    await sleep(250);
  }
  return all;
}

// Cursor pagination over updated_since — walks the full history beyond the
// 300-page / ~2,500-ticket list cap by advancing the cursor in time.
async function fdFetchTickets(sinceISO) {
  const all = [];
  const seen = new Set();
  let cursor = sinceISO;
  for (let round = 0; round < 40; round++) {     // safety cap: 40 cursor advances
    let advanced = false;
    let lastUpdated = null;
    const before = seen.size;
    for (let page = 1; page <= 50; page++) {
      const data = await fdGet('tickets', {
        updated_since: cursor, include: 'stats',
        per_page: 100, page, order_by: 'updated_at', order_type: 'asc',
      });
      if (!Array.isArray(data) || data.length === 0) break;
      for (const t of data) { if (!seen.has(t.id)) { seen.add(t.id); all.push(t); } }
      lastUpdated = data[data.length - 1].updated_at;
      if (data.length < 100) break;          // reached the end
      if (page === 50) advanced = true;        // hit page cap → advance cursor
      await sleep(300);
    }
    // Stop if no advance needed, cursor stalled, or this round added nothing new
    // (guards against Freshdesk ignoring the asc sort and re-scanning the window).
    if (!advanced || !lastUpdated || lastUpdated === cursor || seen.size === before) break;
    cursor = lastUpdated;                       // continue from last seen timestamp
  }
  return all;
}

// ─── VOICEFLOW ──────────────────────────────────────────────────────────────
async function vfGetAll(days) {
  const cutoff = new Date(Date.now() - days * 86400000);
  const all = [];
  let nextToken = null;
  try {
    for (let page = 0; page < 300; page++) {     // safety cap: 30,000 transcripts
      const url = new URL(`https://api.voiceflow.com/v2/transcripts/${VF_PROJECT}`);
      url.searchParams.set('limit', '100');
      if (nextToken) url.searchParams.set('nextToken', nextToken);
      const res = await fetch(url, { headers: { Authorization: VF_KEY, accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();

      const items = Array.isArray(body) ? body : (body.data ?? body.items ?? body.transcripts ?? []);
      nextToken = body.nextToken ?? null;
      if (items.length === 0) break;

      const inRange = items.filter(s => new Date(s.createdAt ?? s.updatedAt ?? 0) >= cutoff);
      all.push(...inRange);

      const allOld = items.every(s => new Date(s.createdAt ?? s.updatedAt ?? 0) < cutoff);
      if (allOld || Array.isArray(body) || !nextToken) break;
      await sleep(100);
    }
    return all;
  } catch (e) {
    console.warn('Voiceflow error:', e.message);
    return null;
  }
}

// ─── CLASSIFICATION ─────────────────────────────────────────────────────────
function isEscalated(s) {
  const blob = JSON.stringify(s.turns ?? []).toLowerCase();
  return ESCALATION_KW.some(kw => blob.includes(kw));
}

function isBounce(s) {
  return !(s.turns ?? []).some(t => t.type === 'request');
}

function getCategory(text = '') {
  const t = text.toLowerCase();
  for (const [name, def] of Object.entries(CATEGORIES)) {
    if (def.kw.some(kw => t.includes(kw))) return name;
  }
  return 'General Inquiry';
}

function sentimentScore(text = '') {
  const t = text.toLowerCase();
  const pos = ['thank', 'great', 'perfect', 'excellent', 'amazing', 'helpful', 'appreciate', 'love', 'wonderful', 'resolved', 'fixed', 'happy', 'easy'];
  const neg = ['frustrated', 'angry', 'terrible', 'awful', 'worst', 'useless', 'unacceptable', 'disappointed', 'broken', 'ridiculous', 'annoying', 'again', 'still not'];
  const posN = pos.filter(w => t.includes(w)).length;
  const negN = neg.filter(w => t.includes(w)).length;
  if (posN + negN === 0) return 0.55;
  return Math.min(0.99, Math.max(0.01, (posN + 0.4) / (posN + negN + 0.8)));
}

function getEscalationReason(s) {
  const blob = JSON.stringify(s.turns ?? []).toLowerCase();
  const fallbacks = (blob.match(/rephrase|didn't quite|not sure i understand|could you clarify/g) ?? []).length;
  if (fallbacks >= 2) return 'Repeated fallback';
  for (const r of ESC_REASONS) {
    if (r.kw.length > 0 && r.kw.some(kw => blob.includes(kw))) return r.name;
  }
  return 'No matching intent / out of scope';
}

function firstUserMsg(s) {
  const req = (s.turns ?? []).find(t => t.type === 'request');
  return req?.payload?.payload?.query ?? req?.payload?.query ?? req?.payload?.message ?? '';
}

function normalizeCsatRating(ratings = {}) {
  const v = ratings.default_question ?? ratings.overall;
  if (v == null) return null;
  if (v === 1 || v === -1) return v === 1;        // classic binary Happy/Unhappy
  if (v >= 1 && v <= 3)   return v >= 3;           // 3-point scale
  if (v >= 1 && v <= 5)   return v >= 4;           // 5-star scale
  if (v >= 99 && v <= 103) return v >= 101;         // Freshdesk encoded (101=Happy)
  return null;
}

// ─── DAILY ROLLUPS ───────────────────────────────────────────────────────────
function buildDailyRollups(tickets, sessions, csat, days, generalId) {
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const dayKeys = [];
  for (let i = days - 1; i >= 0; i--) dayKeys.push(new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10));

  const blank = () => ({
    ticketsCreated: 0, ticketsResolved: 0, backlog: 0,
    csatHappy: 0, csatTotal: 0, slaHit: 0, slaEligible: 0,
    frtSum: 0, frtCount: 0, stewartTickets: 0,
    sessions: 0, bounces: 0, engaged: 0, aiResolved: 0,
    topics: {}, escReasons: {},
  });
  const map = {};
  dayKeys.forEach(d => { map[d] = blank(); });

  const topicBucket = (day, cat) => {
    if (!map[day].topics[cat]) map[day].topics[cat] = { count: 0, sentSum: 0, aiTotal: 0, aiResolved: 0 };
    return map[day].topics[cat];
  };

  // Tickets: created volume, topic/sentiment, SLA, FRT, stewart tag, resolved volume
  for (const t of tickets) {
    const created = dayKey(t.created_at);
    if (created && map[created]) {
      const m = map[created];
      m.ticketsCreated++;
      if ((t.tags ?? []).includes(STEWART_TAG)) m.stewartTickets++;
      const text = `${t.subject ?? ''} ${(t.tags ?? []).join(' ')}`;
      const tb = topicBucket(created, getCategory(text));
      tb.count++;
      tb.sentSum += sentimentScore(text);
      if (t.group_id === generalId && t.stats?.first_responded_at) {
        const frtH = (new Date(t.stats.first_responded_at) - new Date(t.created_at)) / 3600000;
        if (frtH > 0 && frtH < 336) { m.frtSum += frtH; m.frtCount++; }
        m.slaEligible++;
        if (frtH <= (SLA_HOURS[t.priority] ?? 8)) m.slaHit++;
      }
    }
    const resolved = dayKey(t.stats?.resolved_at);
    if (resolved && map[resolved]) map[resolved].ticketsResolved++;
  }

  // Backlog snapshot: tickets open at the end of each day
  for (const d of dayKeys) {
    const dayEnd = new Date(d + 'T23:59:59.999Z');
    let open = 0;
    for (const t of tickets) {
      if (new Date(t.created_at) > dayEnd) continue;
      const r = t.stats?.resolved_at ? new Date(t.stats.resolved_at) : null;
      if (!r || r > dayEnd) open++;
    }
    map[d].backlog = open;
  }

  // CSAT ratings
  for (const r of (csat ?? [])) {
    const d = dayKey(r.created_at);
    if (!d || !map[d]) continue;
    map[d].csatTotal++;
    if (normalizeCsatRating(r.ratings ?? {}) === true) map[d].csatHappy++;
  }

  // Voiceflow sessions
  for (const s of (sessions ?? [])) {
    const d = dayKey(s.createdAt ?? s.updatedAt);
    if (!d || !map[d]) continue;
    const m = map[d];
    m.sessions++;
    if (isBounce(s)) { m.bounces++; continue; }
    m.engaged++;
    const tb = topicBucket(d, getCategory(firstUserMsg(s)));
    tb.aiTotal++;
    if (isEscalated(s)) {
      const reason = getEscalationReason(s);
      m.escReasons[reason] = (m.escReasons[reason] || 0) + 1;
    } else {
      m.aiResolved++;
      tb.aiResolved++;
    }
  }

  return dayKeys.map(d => ({ date: d, ...map[d] }));
}

// ─── CONVERSATIONS WORTH READING ──────────────────────────────────────────
// Flat, dated pool — the browser filters by the selected range.
function buildConversations(sessions, tickets) {
  if (!sessions) return [];
  const engaged = sessions.filter(s => !isBounce(s));

  const scored = engaged.map(s => {
    const msg  = firstUserMsg(s);
    const esc  = isEscalated(s);
    const d    = new Date(s.createdAt ?? s.updatedAt ?? Date.now());
    const when = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
               + ', ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const match = esc ? tickets.find(t => {
      const td = new Date(t.created_at);
      return (t.tags ?? []).includes(STEWART_TAG) && Math.abs(td - d) < 3600000;
    }) : null;
    return {
      date: isNaN(d) ? null : d.toISOString().slice(0, 10),
      esc, sent: sentimentScore(msg), cat: getCategory(msg), when,
      ticketId: match?.id ?? null, reason: esc ? getEscalationReason(s) : null,
    };
  }).filter(x => x.date);

  const stars = scored.filter(x => !x.esc).sort((a, b) => b.sent - a.sent).slice(0, 60).map(x => ({
    date: x.date, type: 'star', when: x.when, topic: x.cat, sentiment: +x.sent.toFixed(2),
    note: 'Stewart resolved this conversation end-to-end with no human handoff.', ticketId: null,
  }));
  const issues = scored.filter(x => x.esc).sort((a, b) => a.sent - b.sent).slice(0, 60).map(x => ({
    date: x.date, type: 'issue', when: x.when, topic: x.cat, sentiment: +x.sent.toFixed(2),
    note: x.reason + '.', ticketId: x.ticketId ? String(x.ticketId) : null,
  }));

  return [...stars, ...issues];
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  if (!FD_KEY) throw new Error('FRESHDESK_KEY env var not set');
  if (!VF_KEY) throw new Error('VOICEFLOW_KEY env var not set');

  const since = daysAgoISO(LOOKBACK_DAYS + FETCH_BUFFER_DAYS);

  console.log('Fetching Freshdesk groups…');
  const groups = await fdGet('groups');
  const gen    = groups.find(g => g.name === GENERAL_GROUP);
  if (!gen) throw new Error(`Freshdesk group "${GENERAL_GROUP}" not found`);
  const generalId = gen.id;

  console.log(`Fetching Freshdesk tickets (${LOOKBACK_DAYS}d, cursor-paginated)…`);
  const allTickets = await fdFetchTickets(since);
  console.log(`  → ${allTickets.length} tickets`);

  console.log('Fetching Freshdesk CSAT ratings…');
  let csatRatings = [];
  try {
    csatRatings = await fdGetAll('surveys/satisfaction_ratings', { created_since: since });
    console.log(`  → ${csatRatings.length} ratings`);
  } catch (e1) {
    try {
      csatRatings = await fdGetAll('satisfaction_ratings', { created_since: since });
      console.log(`  → ${csatRatings.length} ratings`);
    } catch (e2) {
      console.warn('  CSAT unavailable:', e2.message);
    }
  }

  console.log(`Fetching Voiceflow transcripts (${LOOKBACK_DAYS}d)…`);
  const allSessions = await vfGetAll(LOOKBACK_DAYS);
  console.log(`  → ${allSessions?.length ?? 'n/a'} sessions`);

  console.log('Computing daily rollups…');
  const daily         = buildDailyRollups(allTickets, allSessions, csatRatings, LOOKBACK_DAYS, generalId);
  const conversations = buildConversations(allSessions, allTickets);

  const out = {
    generatedAt:     new Date().toISOString(),
    fdSubdomain:     FD_DOMAIN,
    costPerSession:  COST_PER_SESSION,
    humanTicketCost: HUMAN_TICKET_COST,
    lookbackDays:    LOOKBACK_DAYS,
    categories:      CATEGORY_LIST,
    escReasonNames:  ESC_REASON_NAMES,
    daily,
    conversations,
    roadmap:         ROADMAP,
  };

  const path = join(process.cwd(), 'docs', 'data.json');
  writeFileSync(path, JSON.stringify(out));

  const totalTix = daily.reduce((s, d) => s + d.ticketsCreated, 0);
  const totalSes = daily.reduce((s, d) => s + d.sessions, 0);
  console.log(`\n✓ Wrote ${path}`);
  console.log(`  ${daily.length} days · ${totalTix} tickets · ${totalSes} sessions · ${conversations.length} flagged convos`);
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
