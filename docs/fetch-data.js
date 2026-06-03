#!/usr/bin/env node
// fetch-data.js — runs in GitHub Actions, writes docs/data.json
// Node 20+ (built-in fetch). Run: node docs/fetch-data.js

import { writeFileSync } from 'fs';
import { join } from 'path';

// ─── CONFIG ────────────────────────────────────────────────────────────────
const FD_KEY      = process.env.FRESHDESK_KEY;
const VF_KEY      = process.env.VOICEFLOW_KEY;
const FD_DOMAIN   = process.env.FRESHDESK_DOMAIN || 'universaltennis';
const VF_PROJECT  = '69ebdbdd003c5c7a49123a84';

const STEWART_TAG       = 'Stewart_AI';
const GENERAL_GROUP     = 'General';
const SHIFT_HOURS       = 10;
const COST_PER_SESSION  = 0.05;   // $/session — update to match your Voiceflow bill
const HUMAN_TICKET_COST = 6.00;   // fully-loaded cost per human-handled ticket, for roadmap ROI
const NUM_WEEKS         = 6;

// SLA first-response thresholds (calendar hours). Update to match your Freshdesk policy.
// Freshdesk priority: 1=Low, 2=Medium/Normal, 3=High, 4=Urgent
const SLA_HOURS = { 1: 24, 2: 8, 3: 4, 4: 1 };

const ESCALATION_KW = [
  'agent', 'human', 'transfer', 'escalat', 'handoff',
  'live chat', 'representative', 'speak to', 'talk to someone',
];

// Categories: keywords matched against ticket subject + tags + first VF user message
const CATEGORIES = {
  'Account / Login':    { kw: ['account', 'login', 'password', 'sign in', 'access', 'locked', 'forgot'], color: '#4f46e5', sentAdj:  0.00 },
  'Ranking / UTR':      { kw: ['ranking', 'rank', 'utr', 'rating', 'score', 'algorithm'],                color: '#0891b2', sentAdj:  0.03 },
  'Tournament':         { kw: ['tournament', 'event', 'register', 'sign up', 'draw', 'wildcard'],        color: '#16a34a', sentAdj:  0.04 },
  'Billing':            { kw: ['billing', 'payment', 'charge', 'refund', 'invoice', 'money', 'fee'],     color: '#dc2626', sentAdj: -0.08 },
  'Technical Issue':    { kw: ['error', 'bug', 'not working', 'broken', 'crash', 'loading', 'slow'],     color: '#d97706', sentAdj: -0.06 },
  'Match Results':      { kw: ['match', 'result', 'score', 'win', 'loss', 'played', 'dispute'],          color: '#7c3aed', sentAdj:  0.01 },
  'Profile / Settings': { kw: ['profile', 'photo', 'name', 'update', 'settings', 'edit'],               color: '#0d9488', sentAdj:  0.01 },
};

// Escalation root-cause buckets — order matters (first match wins)
const ESC_REASONS = [
  { name: 'User asked for a human',            kw: ['human', 'agent', 'person', 'representative', 'speak to', 'talk to'] },
  { name: 'No matching intent / out of scope', kw: ["don't understand", "not sure", "can't help with that", "outside", "don't have info", "not familiar"] },
  { name: 'Knowledge gap (no KB answer)',      kw: ["don't know", "can't find", "no information", "don't have details", "more info"] },
  { name: "Account action bot can't perform",  kw: ["can't do that", "unable to", "not able to", "manual process", "team will"] },
  { name: 'Repeated fallback',                 kw: [] }, // detected structurally
];

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

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

// ─── FRESHDESK ──────────────────────────────────────────────────────────────
const FD_AUTH = () => 'Basic ' + Buffer.from(`${FD_KEY}:X`).toString('base64');

async function fdGet(path, params = {}) {
  const url = new URL(`https://${FD_DOMAIN}.freshdesk.com/api/v2/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const res = await fetch(url, { headers: { Authorization: FD_AUTH() } });
  if (!res.ok) throw new Error(`Freshdesk ${path}: HTTP ${res.status}`);
  return res.json();
}

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

// ─── VOICEFLOW ──────────────────────────────────────────────────────────────
async function vfGetAll(hours) {
  const start = new Date(Date.now() - hours * 3600000).toISOString();
  try {
    const url = new URL(`https://api.voiceflow.com/v2/transcripts/${VF_PROJECT}`);
    url.searchParams.set('range[start]', start);
    const res = await fetch(url, { headers: { Authorization: VF_KEY } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data) ? data : (data.data ?? data.items ?? []);
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
  // Structural: detect repeated fallback patterns
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

// ─── WEEKLY BUCKETS ─────────────────────────────────────────────────────────
function getWeekBuckets(n = NUM_WEEKS) {
  const now = new Date();
  now.setHours(23, 59, 59, 999);
  return Array.from({ length: n }, (_, i) => {
    const daysBack = (n - 1 - i) * 7;
    const end   = new Date(now.getTime() - daysBack * 86400000);
    const start = new Date(end.getTime() - 7 * 86400000 + 1000);
    const fmt   = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return { label: `${fmt(start)} – ${fmt(new Date(end.getTime() - 86400000))}`, start, end };
  });
}

// ─── PER-WEEK METRICS ───────────────────────────────────────────────────────
function weekMetrics(allTickets, allSessions, csatRatings, bucket, generalId) {
  // Ticket slices
  const tickets = allTickets.filter(t => {
    const d = new Date(t.created_at);
    return d >= bucket.start && d <= bucket.end;
  });
  const resolvedInWeek = allTickets.filter(t => {
    const d = t.stats?.resolved_at ? new Date(t.stats.resolved_at) : null;
    return d && d >= bucket.start && d <= bucket.end;
  });
  const generalTix = tickets.filter(t => t.group_id === generalId);
  const stewartTix = tickets.filter(t => (t.tags ?? []).includes(STEWART_TAG));

  // Backlog: created before end of week, not resolved before end of week
  const backlog = allTickets.filter(t => {
    const created  = new Date(t.created_at);
    const resolved = t.stats?.resolved_at ? new Date(t.stats.resolved_at) : null;
    return created <= bucket.end && (!resolved || resolved > bucket.end);
  }).length;

  // VF session slices
  const sessions = (allSessions ?? []).filter(s => {
    const d = new Date(s.createdAt ?? s.updatedAt ?? 0);
    return d >= bucket.start && d <= bucket.end;
  });
  const bounces  = sessions.filter(isBounce);
  const engaged  = sessions.filter(s => !isBounce(s));
  const aiResolved = engaged.filter(s => !isEscalated(s));

  // CSAT
  const weekCsat = csatRatings.filter(r => {
    const d = new Date(r.created_at);
    return d >= bucket.start && d <= bucket.end;
  });
  let csat = null;
  if (weekCsat.length > 0) {
    const happy = weekCsat.filter(r => normalizeCsatRating(r.ratings ?? {}) === true).length;
    csat = +(happy / weekCsat.length * 100).toFixed(1);
  }

  // SLA attainment
  const slaable = generalTix.filter(t => t.stats?.first_responded_at);
  const slaHit  = slaable.filter(t => {
    const frtH  = (new Date(t.stats.first_responded_at) - new Date(t.created_at)) / 3600000;
    const limit = SLA_HOURS[t.priority] ?? 8;
    return frtH <= limit;
  });
  const slaAttainment = slaable.length > 0 ? +(slaHit.length / slaable.length * 100).toFixed(1) : null;

  // Avg FRT (hours)
  const frtSamples = generalTix
    .filter(t => t.stats?.first_responded_at)
    .map(t => (new Date(t.stats.first_responded_at) - new Date(t.created_at)) / 3600000)
    .filter(v => v > 0 && v < 336);
  const avgFRTHours = frtSamples.length > 0 ? +(frtSamples.reduce((a, b) => a + b, 0) / frtSamples.length).toFixed(2) : null;

  // Bypass: tickets with no Stewart touchpoint / total tickets
  const bypassPct = tickets.length > 0
    ? +((tickets.length - stewartTix.length) / tickets.length * 100).toFixed(1)
    : null;

  const cost = sessions.length * COST_PER_SESSION;

  return {
    label: bucket.label,
    ticketsCreated:   tickets.length,
    ticketsResolved:  resolvedInWeek.length,
    backlog,
    csat,
    slaAttainment,
    avgFRTHours,
    sessions:         sessions.length,
    bounces:          bounces.length,
    engagedSessions:  engaged.length,
    aiResolved:       aiResolved.length,
    aiResolutionPct:  engaged.length > 0 ? +(aiResolved.length / engaged.length * 100).toFixed(1) : null,
    bouncePct:        sessions.length > 0 ? +(bounces.length / sessions.length * 100).toFixed(1) : null,
    bypassPct,
    cost:             +cost.toFixed(2),
    costPerResolution: aiResolved.length > 0 ? +(cost / aiResolved.length).toFixed(3) : null,
  };
}

// ─── DAILY VOLUME ────────────────────────────────────────────────────────────
function computeDaily(allTickets, days = 42) {
  const now = new Date();
  return Array.from({ length: days }, (_, i) => {
    const dayStart = new Date(now - (days - 1 - i) * 86400000);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart.getTime() + 86400000);
    return {
      label: dayStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      count: allTickets.filter(t => { const d = new Date(t.created_at); return d >= dayStart && d < dayEnd; }).length,
    };
  });
}

// ─── AI RESOLUTION BY TYPE ────────────────────────────────────────────────
function computeAiResByType(allSessions) {
  if (!allSessions) return [];
  const map = {};
  allSessions.filter(s => !isBounce(s)).forEach(s => {
    const cat = getCategory(firstUserMsg(s));
    if (!map[cat]) map[cat] = { total: 0, resolved: 0 };
    map[cat].total++;
    if (!isEscalated(s)) map[cat].resolved++;
  });
  return Object.entries(map)
    .filter(([, v]) => v.total >= 3)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 8)
    .map(([name, v]) => ({ name, pct: +(v.resolved / v.total * 100).toFixed(1), volume: v.total }));
}

// ─── TOP TOPICS (with sentiment) ──────────────────────────────────────────
function computeTopTopics(allTickets) {
  const map = {};
  allTickets.forEach(t => {
    const text = `${t.subject ?? ''} ${(t.tags ?? []).join(' ')}`;
    const cat  = getCategory(text);
    const sent = sentimentScore(text);
    if (!map[cat]) map[cat] = { count: 0, sentSum: 0 };
    map[cat].count++;
    map[cat].sentSum += sent;
  });
  const total = allTickets.length || 1;
  return Object.entries(map)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 8)
    .map(([name, v]) => ({
      name,
      pct:       +(v.count / total * 100).toFixed(1),
      sentiment: +(v.sentSum / v.count).toFixed(2),
      color:     (CATEGORIES[name]?.color ?? '#94a3b8'),
    }));
}

// ─── TOPIC VOLUME BY WEEK ─────────────────────────────────────────────────
function computeTopicVol(allTickets, buckets) {
  const catNames = [...Object.keys(CATEGORIES).slice(0, 5), 'General Inquiry'];
  return {
    series: catNames.map(cat => ({
      name:  cat,
      color: CATEGORIES[cat]?.color ?? '#94a3b8',
      data:  buckets.map(b =>
        allTickets.filter(t => {
          const d    = new Date(t.created_at);
          const text = `${t.subject ?? ''} ${(t.tags ?? []).join(' ')}`;
          return d >= b.start && d <= b.end && getCategory(text) === cat;
        }).length
      ),
    })),
  };
}

// ─── ESCALATION REASONS ───────────────────────────────────────────────────
function computeEscReasons(allSessions) {
  if (!allSessions) return [];
  const escalated = allSessions.filter(s => !isBounce(s) && isEscalated(s));
  if (escalated.length === 0) return [];
  const counts = {};
  escalated.forEach(s => { const r = getEscalationReason(s); counts[r] = (counts[r] || 0) + 1; });
  const total = escalated.length;
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => ({ name, pct: +(n / total * 100).toFixed(1) }));
}

// ─── CONVERSATIONS WORTH READING ──────────────────────────────────────────
function computeConversations(allSessions, allTickets) {
  if (!allSessions) return [];
  const engaged = allSessions.filter(s => !isBounce(s));

  const scored = engaged.map(s => {
    const msg  = firstUserMsg(s);
    const esc  = isEscalated(s);
    const sent = sentimentScore(msg);
    const cat  = getCategory(msg);
    const d    = new Date(s.createdAt ?? s.updatedAt ?? Date.now());
    const when = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
               + ', '
               + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    // Try to match a ticket by tag + proximity
    const match = esc ? allTickets.find(t => {
      const td = new Date(t.created_at);
      return (t.tags ?? []).includes(STEWART_TAG) && Math.abs(td - d) < 3600000;
    }) : null;
    return { esc, sent, cat, when, msg, ticketId: match?.id ?? null, reason: esc ? getEscalationReason(s) : null };
  });

  // Top 3 standouts (highest sentiment, not escalated)
  const stars = scored.filter(x => !x.esc).sort((a, b) => b.sent - a.sent).slice(0, 3).map(x => ({
    type: 'star', when: x.when, topic: x.cat, sentiment: +x.sent.toFixed(2),
    note: 'Stewart resolved this conversation end-to-end with no human handoff.',
    ticketId: null,
  }));

  // Top 3 problems (lowest sentiment, escalated)
  const issues = scored.filter(x => x.esc).sort((a, b) => a.sent - b.sent).slice(0, 3).map(x => ({
    type: 'issue', when: x.when, topic: x.cat, sentiment: +x.sent.toFixed(2),
    note: x.reason + '.',
    ticketId: x.ticketId ? String(x.ticketId) : null,
  }));

  // Interleave: star, issue, star, issue…
  const out = [];
  const maxLen = Math.max(stars.length, issues.length);
  for (let i = 0; i < maxLen; i++) {
    if (stars[i])  out.push(stars[i]);
    if (issues[i]) out.push(issues[i]);
  }
  return out;
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  if (!FD_KEY) throw new Error('FRESHDESK_KEY env var not set');
  if (!VF_KEY) throw new Error('VOICEFLOW_KEY env var not set');

  const DAYS   = NUM_WEEKS * 7;   // 42
  const since  = daysAgo(DAYS);
  const buckets = getWeekBuckets();

  console.log('Fetching Freshdesk groups…');
  const groups = await fdGet('groups');
  const gen    = groups.find(g => g.name === GENERAL_GROUP);
  if (!gen) throw new Error(`Freshdesk group "${GENERAL_GROUP}" not found`);
  const generalId = gen.id;

  console.log(`Fetching Freshdesk tickets (${DAYS}d)…`);
  const allTickets = await fdGetAll('tickets', { updated_since: since, include: 'stats' });
  console.log(`  → ${allTickets.length} tickets`);

  console.log('Fetching Freshdesk CSAT ratings…');
  let csatRatings = [];
  try {
    csatRatings = await fdGetAll('satisfaction_ratings', { created_since: since });
    console.log(`  → ${csatRatings.length} ratings`);
  } catch (e) {
    console.warn('  CSAT unavailable:', e.message);
  }

  console.log(`Fetching Voiceflow transcripts (${DAYS}d)…`);
  const allSessions = await vfGetAll(DAYS * 24);
  console.log(`  → ${allSessions?.length ?? 'n/a'} sessions`);

  console.log('Computing metrics…');
  const weeks              = buckets.map(b => weekMetrics(allTickets, allSessions, csatRatings, b, generalId));
  const daily              = computeDaily(allTickets, DAYS);
  const aiResolutionByType = computeAiResByType(allSessions);
  const topTopics          = computeTopTopics(allTickets);
  const topicVol           = computeTopicVol(allTickets, buckets);
  const escalationReasons  = computeEscReasons(allSessions);
  const conversations      = computeConversations(allSessions, allTickets);

  const out = {
    generatedAt:       new Date().toISOString(),
    fdSubdomain:       FD_DOMAIN,
    costPerSession:    COST_PER_SESSION,
    humanTicketCost:   HUMAN_TICKET_COST,
    weeks,
    daily,
    aiResolutionByType,
    topTopics,
    topicVol,
    escalationReasons,
    conversations,
    roadmap: ROADMAP,
  };

  const path = join(process.cwd(), 'docs', 'data.json');
  writeFileSync(path, JSON.stringify(out, null, 2));

  const latest = weeks[weeks.length - 1];
  console.log(`\n✓ Wrote ${path}`);
  console.log(`  Latest week (${latest.label}): ${latest.ticketsCreated} tickets · ${latest.sessions} sessions · ${latest.aiResolutionPct ?? '—'}% AI resolution · bypass ${latest.bypassPct ?? '—'}%`);
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
