#!/usr/bin/env node
// fetch-css-data.js — runs weekly on Mondays, writes css-data.json
// Node 20+ required (built-in fetch).
// Env vars: FRESHDESK_KEY, VOICEFLOW_KEY, GOOGLE_SHEETS_API_KEY
// Optional: FRESHDESK_DOMAIN (default: universaltennis), VF_COST_PER_SESSION (default: 0.05)

import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── CONFIG ─────────────────────────────────────────────────────────────────
const FD_KEY          = process.env.FRESHDESK_KEY;
const VF_KEY          = process.env.VOICEFLOW_KEY;
const SHEETS_KEY      = process.env.GOOGLE_SHEETS_API_KEY || 'AIzaSyB3IzdUSQKG5NPrfdr5y4x-KmZkmeZDb0o';
const VF_COST         = parseFloat(process.env.VF_COST_PER_SESSION || '0.05');
const FD_DOMAIN       = process.env.FRESHDESK_DOMAIN || 'universaltennis';
const VF_PROJECT      = '69ebd4159a532921bd258f8d';
const VF_ANALYTICS    = 'https://analytics-api.voiceflow.com';
const SHEETS_ID       = '19g2G3dlSNba5U5b4Xf6k_jRlMI9S2TVI3Kg7_MLGWGA';

const CSS_GROUP_NAMES = ['General', 'Campaigns', 'Bug Captain'];
const STEWART_TAG     = 'Stewart_AI';
const LOOKBACK_DAYS    = 185;   // ~6 months: covers YTD + prev month (June 2025 handled by supplement)
const DATA_END        = new Date('2024-08-09T23:59:59Z'); // last date with CSS group ticket data
const VF_LOOKBACK_DAYS = parseInt(process.env.VF_LOOKBACK_DAYS || '90', 10); // AI/Voiceflow launched April 2026; 90d covers it
const MIN_SLEEP_MS     = 3000;  // 3s between calls — 20% capacity cap (≈20 req/min) to avoid conflicting with Stewart bot
const VF_SLEEP_MS      = 80;    // Voiceflow rate limits are much more lenient

// Priority labels (Freshdesk: 1=Low 2=Medium 3=High 4=Urgent)
const PRIORITY_NAMES  = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' };
const SLA_HOURS       = { 1: 24, 2: 8, 3: 4, 4: 1 };

const PERSONAS = [
  { name: 'Club customers',    kw: ['club', 'academy', 'facility', 'program', 'director', 'venue', 'organization'] },
  { name: 'Power subscribers', kw: ['power', 'subscription', 'premium', 'pro plan', 'membership', 'subscribe', 'plan'] },
  { name: 'College',           kw: ['college', 'university', 'ncaa', 'collegiate', 'recruit', 'division', 'varsity'] },
  { name: 'High school',       kw: ['high school', 'hs ', 'junior tennis', 'jtr', 'prep school', 'grade', 'school team'] },
  { name: 'Parents',           kw: ['my son', 'my daughter', 'my child', 'my kid', 'as a parent', 'my player', 'our son', 'our daughter'] },
];

// ─── HELPERS ────────────────────────────────────────────────────────────────
const sleep   = ms  => new Promise(r => setTimeout(r, ms));
const dayKey  = v   => { const d = new Date(v); return isNaN(d) ? null : d.toISOString().slice(0, 10); };

function daysAgoISO(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

// ─── PII STRIPPING ──────────────────────────────────────────────────────────
const EMAIL_RE    = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
// "My name is John Smith" → keep first name only
const FULLNAME_RE = /\b(?:my name is|i(?:'m| am)|this is)\s+([A-Z][a-z]+)\s+[A-Z][a-z]+\b/gi;
// City, State patterns after prepositions
const LOCATION_RE = /\b(?:in|from|at|near)\s+[A-Z][a-zA-Z\s]{2,18},?\s*(?:[A-Z]{2})?\b/g;

function stripPII(text) {
  if (!text) return '';
  return text
    .replace(EMAIL_RE, '[email]')
    .replace(FULLNAME_RE, (_, first) => first)
    .replace(LOCATION_RE, '[location]');
}

// ─── FRESHDESK ──────────────────────────────────────────────────────────────
const fdAuth = () => 'Basic ' + Buffer.from(`${FD_KEY}:X`).toString('base64');

async function fdGet(path, params = {}) {
  const url = new URL(`https://${FD_DOMAIN}.freshdesk.com/api/v2/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { headers: { Authorization: fdAuth() } });
    if (res.status === 429) {
      const wait = (+(res.headers.get('retry-after') || 60) + 5) * 1000;
      console.warn(`  rate limited on ${path}, waiting ${wait / 1000}s…`);
      await sleep(wait);
      continue;
    }
    if (res.status === 503 || res.status === 502) {
      const wait = (attempt + 1) * 3000;
      console.warn(`  Freshdesk ${res.status} on ${path}, retrying in ${wait / 1000}s…`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`Freshdesk ${path}: HTTP ${res.status}`);
    return res.json();
  }
  throw new Error(`Freshdesk ${path}: rate-limited after retries`);
}

async function fdGetAll(path, params = {}, maxPages = 25) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await fdGet(path, { ...params, page, per_page: 100 });
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    if (data.length < 100) break;
    await sleep(MIN_SLEEP_MS);
  }
  return all;
}

// Search API — targeted by group_id, no full-table scan needed.
async function fdSearch(query, page) {
  const url = new URL(`https://${FD_DOMAIN}.freshdesk.com/api/v2/search/tickets`);
  url.searchParams.set('query', `"${query}"`);
  url.searchParams.set('page', page);
  for (let attempt = 0; attempt < 5; attempt++) {
    let res;
    try {
      // 30s timeout so a hung socket fails fast and retries instead of blocking forever
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      try {
        res = await fetch(url, { headers: { Authorization: fdAuth() }, signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      console.warn(`  search request failed (${e.name}), retry ${attempt + 1}/5…`);
      await sleep((attempt + 1) * 3000);
      continue;
    }
    if (res.status === 429) {
      const wait = (+(res.headers.get('retry-after') || 60) + 5) * 1000;
      console.warn(`  rate limited on search, waiting ${wait / 1000}s…`);
      await sleep(wait);
      continue;
    }
    if (res.status === 503 || res.status === 502) { await sleep((attempt + 1) * 3000); continue; }
    if (!res.ok) throw new Error(`Freshdesk search: HTTP ${res.status}`);
    return res.json();
  }
  throw new Error('Freshdesk search: rate-limited after retries');
}

async function fdSearchRange(groupId, start, end, allById, depth = 0) {
  const s = start.toISOString().slice(0, 10);
  const e = end.toISOString().slice(0, 10);
  if (s === e) return;
  const pad = '      ' + '  '.repeat(depth);
  const query = `group_id:${groupId} AND created_at:>'${s}' AND created_at:<'${e}'`;

  // Page 1 also tells us the total — if >300 we split immediately instead of
  // wastefully paginating 10 pages and then re-fetching the same period.
  const first = await fdSearch(query, 1);
  for (const t of (first.results ?? [])) allById.set(t.id, t);
  const total = first.total ?? (first.results ?? []).length;

  if (total > 300 && (end.getTime() - start.getTime()) > 86400000) {
    const mid = new Date((start.getTime() + end.getTime()) / 2);
    console.log(`${pad}↳ ${s}–${e} has ${total} (>300), splitting…`);
    await sleep(MIN_SLEEP_MS);
    await fdSearchRange(groupId, start, mid, allById, depth + 1);
    await fdSearchRange(groupId, mid, end, allById, depth + 1);
    return;
  }

  // Leaf range (≤300): paginate the remaining pages we actually need.
  const pages = Math.min(10, Math.ceil(total / 30));
  for (let page = 2; page <= pages; page++) {
    await sleep(MIN_SLEEP_MS);
    const data = await fdSearch(query, page);
    for (const t of (data.results ?? [])) allById.set(t.id, t);
    if ((data.results ?? []).length < 30) break;
  }
}

async function fdFetchTickets(targetMonths, cssGroupIds) {
  // Phase 1: search API — fetch CSS ticket IDs for only the months we need.
  const allById = new Map();
  console.log(`  Search API: ${cssGroupIds.size} groups × ${targetMonths.length} months…`);
  for (const groupId of cssGroupIds) {
    for (const { start, end } of targetMonths) {
      const label = `${start.toISOString().slice(0,7)} grp ${groupId}`;
      console.log(`    → searching ${label}…`);
      await fdSearchRange(groupId, start, end, allById);
      console.log(`    ✓ ${label}: ${allById.size} ids so far`);
      await sleep(MIN_SLEEP_MS);
    }
  }
  console.log(`  → ${allById.size} CSS ticket IDs found`);

  // Phase 2: fill stats via per-month sweeps.
  // A single sweep from June 2025 to now would page through 20k+ tickets across all groups,
  // hitting the page cap before reaching recently-updated current-month tickets.
  // Instead, sweep each target month independently: start at monthStart, stop when
  // updated_at passes monthEnd — each sweep covers ~1 month of updates and stays fast.
  const needsStats = new Set(allById.keys());
  const sortedMonths = [...targetMonths].sort((a, b) => a.start - b.start);
  console.log(`  Filling stats (${sortedMonths.length} month windows)…`);
  for (const { start, end } of sortedMonths) {
    if (needsStats.size === 0) break;
    const label = start.toISOString().slice(0, 7);
    let found = 0;
    for (let page = 1; page <= 50; page++) {
      const data = await fdGet('tickets', {
        updated_since: start.toISOString(), include: 'stats',
        per_page: 100, page, order_by: 'updated_at', order_type: 'asc',
      });
      if (!Array.isArray(data) || data.length === 0) break;
      let pastEnd = false;
      for (const t of data) {
        if (needsStats.has(t.id)) { allById.set(t.id, t); needsStats.delete(t.id); found++; }
        if (t.updated_at && new Date(t.updated_at) > end) pastEnd = true;
      }
      if (pastEnd || data.length < 100) break;
      if (needsStats.size === 0) break;
      await sleep(MIN_SLEEP_MS);
    }
    console.log(`    ${label}: ${found} stats filled, ${needsStats.size} remaining`);
    if (needsStats.size > 0) await sleep(MIN_SLEEP_MS);
  }
  if (needsStats.size > 0) console.log(`  ⚠ ${needsStats.size} tickets missing stats`);

  console.log(`  → ${allById.size} CSS tickets total`);
  return [...allById.values()];
}

// ─── VOICEFLOW ──────────────────────────────────────────────────────────────
const vfHeaders = () => ({ authorization: VF_KEY, 'content-type': 'application/json', accept: 'application/json' });

async function vfGetAll(days) {
  const now = Date.now();
  const numWindows = Math.ceil(days / 7);

  // Fetch weekly windows in parallel batches of 8.
  // Dedup by transcript id — adjacent windows share a boundary instant, so a
  // transcript on the boundary would otherwise be counted (and billed) twice.
  const BATCH = 8;
  const byId = new Map();
  let maxWindow = 0;
  for (let b = 0; b < numWindows; b += BATCH) {
    const batch = [];
    for (let w = b; w < Math.min(b + BATCH, numWindows); w++) {
      // Offset the window start by 1ms so adjacent windows don't overlap on the boundary.
      const winEnd   = new Date(now - w * 7 * 86400000);
      const winStart = new Date(Math.max(now - (w + 1) * 7 * 86400000 + 1, now - days * 86400000));
      batch.push(
        fetch(`${VF_ANALYTICS}/v1/transcript/project/${VF_PROJECT}`, {
          method: 'POST', headers: vfHeaders(),
          body: JSON.stringify({ startDate: winStart.toISOString(), endDate: winEnd.toISOString() }),
        }).then(r => r.ok ? r.json() : null).then(body => body?.transcripts ?? [])
      );
    }
    const results = await Promise.all(batch);
    results.forEach((list, idx) => {
      const w = b + idx;
      // A window returning a large round number likely hit an API cap.
      if (list.length >= 100) console.warn(`  ⚠ VF window ${w} returned ${list.length} — possible result cap`);
      maxWindow = Math.max(maxWindow, list.length);
      for (const t of list) if (t?.id) byId.set(t.id, t);
    });
    await sleep(VF_SLEEP_MS);
  }
  const all = [...byId.values()];
  console.log(`  → ${all.length} unique transcripts (max ${maxWindow}/window)`);

  // Fetch individual transcript logs in parallel batches of 10
  let fetched = 0;
  const LOG_BATCH = 10;
  for (let i = 0; i < all.length; i += LOG_BATCH) {
    const chunk = all.slice(i, i + LOG_BATCH);
    await Promise.all(chunk.map(async t => {
      try {
        const r = await fetch(`${VF_ANALYTICS}/v1/transcript/${t.id}`, { headers: vfHeaders() });
        if (r.ok) {
          const body = await r.json();
          // API may return logs at root or nested under 'transcript'
          t.logs = body.logs ?? body.transcript?.logs ?? [];
          if (t.logs.length > 0) fetched++;
        } else t.logs = [];
      } catch { t.logs = []; }
    }));
    await sleep(VF_SLEEP_MS);
  }
  console.log(`  → ${all.length} transcripts (${fetched} with log entries)`);
  return all;
}

function slateText(slate) {
  const out = [];
  for (const node of (slate?.content ?? [])) {
    for (const child of (node.children ?? [])) {
      if (typeof child.text === 'string') out.push(child.text);
    }
  }
  return out.join(' ');
}

function convText(s) {
  const parts = [];
  for (const l of (s.logs ?? [])) {
    if (l.type === 'action' && l.data?.type === 'text' && typeof l.data.payload === 'string')
      parts.push(l.data.payload);
    else if (l.type === 'trace' && l.data?.type === 'text' && l.data?.payload?.ai) {
      const t = slateText(l.data.payload.slate);
      if (t) parts.push(t);
    }
  }
  return parts.join(' ');
}

function isEscalated(s) {
  // Programmatic escalation: bot actually created a Freshdesk ticket
  if (JSON.stringify(s.logs ?? []).includes('freshdesk_create_ticket')) return true;
  // Keyword escalation: only scan USER messages (type==='action'), not the AI's own text.
  // Checking AI text causes false positives when the bot describes its own capabilities.
  const userText = (s.logs ?? [])
    .filter(l => l.type === 'action' && l.data?.type === 'text' && typeof l.data.payload === 'string')
    .map(l => l.data.payload)
    .join(' ')
    .toLowerCase();
  return ['agent', 'human', 'transfer', 'escalat', 'live chat', 'speak to', 'talk to someone'].some(kw => userText.includes(kw));
}

function isBounce(s) {
  return !(s.logs ?? []).some(l => l.type === 'action' && l.data?.type === 'text');
}

function sessionDurationMin(s) {
  const start = new Date(s.createdAt);
  const end   = new Date(s.updatedAt);
  if (isNaN(start) || isNaN(end)) return null;
  const m = (end - start) / 60000;
  return m > 0 && m < 180 ? m : null;
}

function getPersona(text = '') {
  const t = text.toLowerCase();
  for (const p of PERSONAS) {
    if (p.kw.some(kw => t.includes(kw))) return p.name;
  }
  return null;
}

// Extract readable turns (user + AI), stripped of PII, for display
function extractTurns(s) {
  const turns = [];
  for (const l of (s.logs ?? [])) {
    if (l.type === 'action' && l.data?.type === 'text' && typeof l.data.payload === 'string') {
      turns.push({ role: 'user', text: stripPII(l.data.payload) });
    } else if (l.type === 'trace' && l.data?.type === 'text' && l.data?.payload?.ai) {
      const t = slateText(l.data.payload.slate);
      if (t) turns.push({ role: 'ai', text: stripPII(t) });
    }
  }
  return turns;
}

// ─── HAPPY THOUGHTS — Freshdesk 5-star CSAT with written feedback ────────────
const TOPIC_KEYWORDS = [
  ['payment', ['payment', 'billing', 'charge', 'refund', 'subscription', 'invoice']],
  ['account access', ['login', 'password', 'account', 'sign in', 'access', 'locked']],
  ['ratings & ranking', ['rating', 'ranking', 'utr', 'ranked', 'score', 'points']],
  ['tournament', ['tournament', 'event', 'registration', 'draw', 'bracket', 'match']],
  ['profile', ['profile', 'photo', 'bio', 'update', 'name', 'club']],
  ['app / website', ['app', 'website', 'mobile', 'ios', 'android', 'page', 'button']],
];

function detectTopic(text) {
  const t = text.toLowerCase();
  for (const [label, kws] of TOPIC_KEYWORDS) {
    if (kws.some(kw => t.includes(kw))) return label;
  }
  return 'support experience';
}

function findHappyThoughts(csatRatings) {
  // Filter to highest-rated responses (5-star or thumbs-up) that have written feedback
  const positive = csatRatings.filter(r => {
    const v = r.ratings?.default_question ?? r.ratings?.overall;
    if (v == null) return false;
    // Accept thumbs-up (1), top of 3-pt (3), top of 5-pt (5), emoji top (103)
    const isTop = v === 1 || v === 5 || v === 103 || v === 3;
    const comment = r.feedback ?? r.remarks ?? '';
    return isTop && typeof comment === 'string' && comment.trim().length > 15;
  });

  // Sort by recency, deduplicate near-identical comments, pick up to 3
  const seen = new Set();
  const results = [];
  for (const r of positive.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))) {
    const raw = (r.feedback ?? r.remarks ?? '').trim();
    const key = raw.slice(0, 40).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const quote = stripPII(raw);
    results.push({ quote, context: detectTopic(quote), date: r.created_at });
    if (results.length >= 3) break;
  }
  return results;
}

// ─── PERSONA SENTIMENT — keyword frequency analysis ──────────────────────────
const POS_WORDS = ['thank','thanks','great','awesome','helpful','amazing','perfect',
  'love','excellent','appreciate','resolved','fixed','solved','quick','easy','fast',
  'good','wonderful','fantastic','happy','pleased','clear','worked','working','smooth',
  'simple','brilliant','outstanding','superb','impressed'];
const NEG_WORDS = ['frustrated','annoying','terrible','awful','slow','broken','issue',
  'problem','error','bug','wrong','fail',"can't",'unable','disappointed','confused',
  'unclear','difficult','hard','complicated','unhelpful','not working','doesn\'t work',
  'never','useless','ridiculous','absurd','unacceptable','keeps','still not','no help'];

const TOPIC_WORDS = ['rating','payment','account','tournament','login','profile',
  'subscription','app','ranking','match','email','registration','club','college',
  'recruit','refund','billing','password','schedule','result'];

function countWords(texts, wordList) {
  const counts = {};
  for (const w of wordList) counts[w] = 0;
  for (const text of texts) {
    const t = text.toLowerCase();
    for (const w of wordList) {
      let idx = 0;
      while ((idx = t.indexOf(w, idx)) !== -1) { counts[w]++; idx += w.length; }
    }
  }
  return counts;
}

function topN(counts, n) {
  return Object.entries(counts)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([w]) => w);
}

// Maps raw keywords to readable phrases for natural-sounding summaries
const POS_PHRASES = {
  'thank': 'feeling well taken care of', 'thanks': 'feeling well taken care of',
  'helpful': 'finding support helpful', 'resolved': 'getting issues resolved quickly',
  'fixed': 'getting issues resolved quickly', 'solved': 'getting issues resolved quickly',
  'quick': 'appreciating fast response times', 'easy': 'finding the process easy',
  'great': 'satisfied with the experience', 'awesome': 'satisfied with the experience',
  'amazing': 'satisfied with the experience', 'excellent': 'satisfied with the experience',
  'smooth': 'experiencing smooth interactions', 'clear': 'finding answers clear and direct',
};
const NEG_PHRASES = {
  'frustrated': 'expressing frustration', 'confused': 'experiencing confusion',
  'slow': 'waiting longer than expected', "can't": 'running into blockers',
  'unable': 'running into blockers', 'broken': 'encountering broken features',
  'error': 'hitting errors', 'bug': 'hitting errors',
  'problem': 'needing multiple contacts to resolve issues',
  'issue': 'needing multiple contacts to resolve issues',
  'unclear': 'finding information hard to locate',
};

function buildPersonaSummary(name, texts) {
  if (texts.length < 3) return 'Not enough data from this period.';
  const posCounts   = countWords(texts, POS_WORDS);
  const negCounts   = countWords(texts, NEG_WORDS);
  const topicCounts = countWords(texts, TOPIC_WORDS);

  const posTotal  = Object.values(posCounts).reduce((a, b) => a + b, 0);
  const negTotal  = Object.values(negCounts).reduce((a, b) => a + b, 0);
  const topTopics = topN(topicCounts, 2);
  const topPosKw  = topN(posCounts, 2);
  const topNegKw  = topN(negCounts, 2);

  // Strip trailing "customers" / "subscribers" from name to avoid repetition
  const shortName = name.replace(/\s+(customers|subscribers)$/i, '');
  const topicStr  = topTopics.length > 0
    ? topTopics.map(t => t.charAt(0).toUpperCase() + t.slice(1)).join(' and ')
    : null;

  if (posTotal > negTotal * 1.5) {
    const phrase = topPosKw.map(k => POS_PHRASES[k]).filter(Boolean)[0]
      ?? 'having a positive support experience';
    const suffix = topicStr ? ` Most common topics: ${topicStr}.` : '';
    return `${shortName} contacts were generally ${phrase} this period.${suffix}`;
  } else if (negTotal > posTotal * 1.5) {
    const phrase = topNegKw.map(k => NEG_PHRASES[k]).filter(Boolean)[0]
      ?? 'experiencing more friction than usual';
    const suffix = topicStr ? ` Most common topics: ${topicStr}.` : '';
    return `${shortName} contacts reported ${phrase} this period.${suffix}`;
  } else {
    const suffix = topicStr ? ` Top topics this period: ${topicStr}.` : '';
    return `${shortName} contacts had a mixed experience this period, with both positive feedback and recurring pain points.${suffix}`;
  }
}

function analyzePersonaSentiment(sessions) {
  const buckets = {};
  for (const p of PERSONAS) buckets[p.name] = [];

  for (const s of sessions) {
    if (isBounce(s)) continue;
    const text = convText(s);
    const persona = getPersona(text);
    if (persona) buckets[persona].push(stripPII(text));
  }

  const results = {};
  for (const p of PERSONAS) {
    results[p.name] = buildPersonaSummary(p.name, buckets[p.name]);
  }
  return results;
}

async function pickInteractionExamples(sessions) {
  const engaged = sessions.filter(s => !isBounce(s));
  if (engaged.length === 0) return [];

  const withTurns = engaged
    .map(s => ({ s, turns: extractTurns(s), resolved: !isEscalated(s) }))
    .filter(x => x.turns.length >= 3 && x.turns.length <= 14);

  if (withTurns.length === 0) {
    return engaged.slice(0, 3).map(s => ({
      transcriptId: s.id,
      turns: extractTurns(s),
      date: s.createdAt ?? s.updatedAt,
      resolved: !isEscalated(s),
    }));
  }

  // Pick 3 from the middle of the length distribution = most representative
  withTurns.sort((a, b) => a.turns.length - b.turns.length);
  const n = withTurns.length;
  const indices = [
    Math.floor(n * 0.25),
    Math.floor(n * 0.50),
    Math.floor(n * 0.75),
  ];
  return indices.map(i => ({
    transcriptId: withTurns[i].s.id,
    turns: withTurns[i].turns,
    date: withTurns[i].s.createdAt ?? withTurns[i].s.updatedAt,
    resolved: withTurns[i].resolved,
  }));
}

// ─── DAILY ROLLUPS ───────────────────────────────────────────────────────────
function buildDailyRollups(tickets, sessions, csat, days, generalGroupId = null) {
  // Chat tickets ("Conversation with…") are only counted from the General queue.
  const isChatTicket = t =>
    (t.subject ?? '').trim().toLowerCase().startsWith('conversation with') &&
    (generalGroupId == null || t.group_id === generalGroupId);
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const dayKeys = [];
  for (let i = days - 1; i >= 0; i--)
    dayKeys.push(new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10));

  const blank = () => ({
    ticketsCreated: 0, ticketsResolved: 0, backlog: 0,
    csatHappy: 0, csatTotal: 0,
    fcCsatHappy: 0, fcCsatTotal: 0,
    slaHit: 0, slaEligible: 0,
    frtSum: 0,  frtCount: 0,
    frt1Sum: 0, frt1Count: 0,   // Low
    frt2Sum: 0, frt2Count: 0,   // Medium
    frt3Sum: 0, frt3Count: 0,   // High
    frt4Sum: 0, frt4Count: 0,   // Urgent
    stewartTickets: 0,
    fcTickets: 0,
    fcrResolved: 0, fcrEligible: 0,
    fcr2Resolved: 0, fcr2Eligible: 0,  // Medium priority only
    sessions: 0, bounces: 0, engaged: 0, aiResolved: 0,
    durSum: 0,  durCount: 0,
  });

  const map = {};
  dayKeys.forEach(d => { map[d] = blank(); });

  for (const t of tickets) {
    const created = dayKey(t.created_at);
    if (created && map[created]) {
      const m = map[created];
      m.ticketsCreated++;
      if ((t.tags ?? []).includes(STEWART_TAG)) m.stewartTickets++;
      if (isChatTicket(t)) m.fcTickets++;

      // FCR: resolved without a customer follow-up reply within 24 hours
      if (t.stats?.resolved_at) {
        m.fcrEligible++;
        const resolvedAt = new Date(t.stats.resolved_at);
        const requesterReplied = t.stats?.requester_responded_at
          ? new Date(t.stats.requester_responded_at)
          : null;
        const noFollowUp = !requesterReplied || (requesterReplied - resolvedAt) > 86400000;
        if (noFollowUp) m.fcrResolved++;
        if (t.priority === 2) {
          m.fcr2Eligible++;
          if (noFollowUp) m.fcr2Resolved++;
        }
      }

      if (t.stats?.first_responded_at) {
        const frtH = (new Date(t.stats.first_responded_at) - new Date(t.created_at)) / 3600000;
        if (frtH > 0 && frtH < 336) {
          m.frtSum   += frtH; m.frtCount++;
          const p = t.priority;
          if (p === 1) { m.frt1Sum += frtH; m.frt1Count++; }
          else if (p === 2) { m.frt2Sum += frtH; m.frt2Count++; }
          else if (p === 3) { m.frt3Sum += frtH; m.frt3Count++; }
          else if (p === 4) { m.frt4Sum += frtH; m.frt4Count++; }
          m.slaEligible++;
          if (frtH <= (SLA_HOURS[p] ?? 8)) m.slaHit++;
        }
      }
    }
    const resolved = dayKey(t.stats?.resolved_at);
    if (resolved && map[resolved]) map[resolved].ticketsResolved++;
  }

  // Daily backlog snapshot
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

  // CSAT
  const normCsat = r => {
    const v = r.ratings?.default_question ?? r.ratings?.overall;
    if (v == null) return null;
    if (v === 1 || v === -1) return v === 1;
    if (v >= 1 && v <= 3)   return v >= 3;
    if (v >= 1 && v <= 5)   return v >= 4;
    if (v >= 99 && v <= 103) return v >= 101;
    return null;
  };
  const fcTicketIds = new Set(
    tickets.filter(isChatTicket).map(t => t.id)
  );
  for (const r of (csat ?? [])) {
    const d = dayKey(r.created_at);
    if (!d || !map[d]) continue;
    const happy = normCsat(r) === true;
    map[d].csatTotal++;
    if (happy) map[d].csatHappy++;
    if (fcTicketIds.has(r.ticket_id)) {
      map[d].fcCsatTotal++;
      if (happy) map[d].fcCsatHappy++;
    }
  }

  // Voiceflow sessions
  for (const s of (sessions ?? [])) {
    const d = dayKey(s.createdAt ?? s.updatedAt);
    if (!d || !map[d]) continue;
    const m = map[d];
    m.sessions++;
    if (isBounce(s)) { m.bounces++; continue; }
    m.engaged++;
    if (!isEscalated(s)) m.aiResolved++;
    const dur = sessionDurationMin(s);
    if (dur !== null) { m.durSum += dur; m.durCount++; }
  }

  return dayKeys.map(d => ({ date: d, ...map[d] }));
}

// ─── MONTHLY ROLLUPS ─────────────────────────────────────────────────────────
function buildMonthlyRollups(daily) {
  const byMonth = {};
  for (const d of daily) {
    const mk = d.date.slice(0, 7);
    if (!byMonth[mk]) byMonth[mk] = {
      ticketsCreated: 0, ticketsResolved: 0, backlog: 0,
      csatHappy: 0,   csatTotal: 0,
      fcCsatHappy: 0, fcCsatTotal: 0,
      slaHit: 0,      slaEligible: 0,
      frtSum: 0,      frtCount: 0,
      frt1Sum: 0, frt1Count: 0,
      frt2Sum: 0, frt2Count: 0,
      frt3Sum: 0, frt3Count: 0,
      frt4Sum: 0, frt4Count: 0,
      stewartTickets: 0, fcTickets: 0,
      fcrResolved: 0, fcrEligible: 0,
      fcr2Resolved: 0, fcr2Eligible: 0,
      sessions: 0, bounces: 0, engaged: 0, aiResolved: 0,
      durSum: 0, durCount: 0,
    };
    const m = byMonth[mk];
    for (const k of Object.keys(m)) {
      if (k === 'backlog') m.backlog = d.backlog; // keep last day's snapshot
      else m[k] = (m[k] ?? 0) + (d[k] ?? 0);
    }
  }
  return byMonth;
}

// ─── GOOGLE SHEETS — CSS METRICS (Ticket Volume + CSAT) ─────────────────────
async function fetchCSSMetrics() {
  if (!SHEETS_KEY) return null;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEETS_ID}/values/Dashboard!A1:Z30?key=${SHEETS_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Google Sheets CSS metrics: HTTP ${res.status}`);
  const rows = (await res.json()).values ?? [];

  // Row 2 (index 1): month headers — "May 2026", "% Change…", "SAME MONTH PY…", "Goals", "April 2026", …
  const headerRow = rows[1] ?? [];
  const csatRow   = rows.find(r => r[0] === 'CSS Controllable CSAT') ?? [];
  const tickRow   = rows.find(r => r[0] === 'Total Ticket Volume')   ?? [];

  const monthly = {};
  for (let col = 1; col < headerRow.length; col++) {
    const key = parseMonthKey(headerRow[col]); // skips non-month headers like "% Change", "Goals"
    if (!key) continue;
    const rawCsat   = csatRow[col];
    const rawTicket = tickRow[col];
    monthly[key] = {
      csat:         parsePct(rawCsat),
      ticketVolume: rawTicket ? parseFloat(String(rawTicket).replace(/,/g, '')) || null : null,
    };
  }
  return { monthly };
}

// ─── GOOGLE SHEETS — REVENUE RECOVERY ───────────────────────────────────────
const MONTH_NAMES = ['January','February','March','April','May','June',
                     'July','August','September','October','November','December'];

function parseMonthKey(label) {
  // "May 2026" → "2026-05"
  if (!label) return null;
  const parts = label.trim().split(' ');
  if (parts.length !== 2) return null;
  const m = MONTH_NAMES.indexOf(parts[0]);
  const y = parseInt(parts[1], 10);
  if (m === -1 || isNaN(y)) return null;
  return `${y}-${String(m + 1).padStart(2, '0')}`;
}

function parseDollar(v) {
  if (!v || typeof v !== 'string') return null;
  const n = parseFloat(v.replace(/[$,]/g, ''));
  return isNaN(n) ? null : n;
}

function parsePct(v) {
  if (!v || typeof v !== 'string') return null;
  const n = parseFloat(v.replace('%', ''));
  return isNaN(n) ? null : n;
}

async function fetchRevenueRecovery() {
  if (!SHEETS_KEY) {
    console.warn('  GOOGLE_SHEETS_API_KEY not set — Revenue Recovery will be empty');
    return null;
  }
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEETS_ID}/values/Dashboard!A1:Z100?key=${SHEETS_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Google Sheets: HTTP ${res.status}`);
  const body = await res.json();
  const rows = body.values ?? [];

  // Find the Revenue Recovery block — locate the "Month" header row
  const monthRowIdx = rows.findIndex(r => r[0] === 'Month');
  if (monthRowIdx === -1) throw new Error('Could not find "Month" row in Dashboard sheet');

  const monthRow     = rows[monthRowIdx];
  const failedRow    = rows.find(r => r[0] === 'Grand Total Failed')  ?? [];
  const savedRow     = rows.find(r => r[0] === 'Grand Total Saved')   ?? [];
  const rateRow      = rows.find(r => r[0]?.trim() === 'Recovery Rate') ?? [];
  const unrecovRow   = rows.find(r => r[0] === 'unrecovered_revenue') ?? [];
  const inRecovRow   = rows.find(r => r[0] === 'in_recovery_revenue') ?? [];

  // Build monthly map: { "2026-05": { failed, saved, rate }, ... }
  const monthly = {};
  for (let col = 1; col < monthRow.length; col++) {
    const key = parseMonthKey(monthRow[col]);
    if (!key) continue;
    monthly[key] = {
      failed: parseDollar(failedRow[col]),
      saved:  parseDollar(savedRow[col]),
      rate:   parsePct(rateRow[col]),
    };
  }

  return {
    monthly,
    unrecoveredRevenue: parseDollar(unrecovRow[1]),
    inRecoveryRevenue:  parseDollar(inRecovRow[1]),
    lastUpdated: rows[monthRowIdx - 1]?.[1] ?? null,
  };
}


// ─── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  if (!FD_KEY) throw new Error('FRESHDESK_KEY env var not set');
  if (!VF_KEY) throw new Error('VOICEFLOW_KEY env var not set');

  console.log('Fetching Freshdesk groups…');
  const allGroups  = await fdGet('groups');
  console.log(`  All groups: ${allGroups.map(g => `"${g.name}" (${g.id})`).join(', ')}`);
  const cssGroupIds = new Set(
    allGroups.filter(g => CSS_GROUP_NAMES.includes(g.name)).map(g => g.id)
  );
  // Chat tickets are only counted from the General queue.
  const generalGroupId = allGroups.find(g => g.name === 'General')?.id ?? null;
  console.log(`  General queue id for chat: ${generalGroupId ?? 'NOT FOUND'}`);
  if (cssGroupIds.size === 0)
    throw new Error(`No CSS groups found matching: ${CSS_GROUP_NAMES.join(', ')}`);
  console.log(`  → matched ${cssGroupIds.size} group(s): ${allGroups.filter(g => CSS_GROUP_NAMES.includes(g.name)).map(g => `"${g.name}" (${g.id})`).join(', ')}`);

  // The 3 volatile months always re-fetched: previous month, current month, same month last year.
  // Stable historical YTD months (Jan–(current-2)) come from cached css-data.json — but if the
  // cache is missing any of them, we fetch them too so the dashboard self-heals.
  const now2 = new Date();
  const curMonth  = now2.getMonth();
  const curYear   = now2.getFullYear();
  const prevMonthKey = new Date(Date.UTC(curYear, curMonth - 1, 1)).toISOString().slice(0, 7);
  const curMonthKey  = new Date(Date.UTC(curYear, curMonth,     1)).toISOString().slice(0, 7);
  const pyStart = new Date(Date.UTC(curYear - 1, curMonth,     1));
  const pyEnd   = new Date(Date.UTC(curYear - 1, curMonth + 1, 1));
  const pyMonthKey = pyStart.toISOString().slice(0, 7);

  // Read cache up front to know which historical months we already have.
  const cachedPath = join(__dirname, 'css-data.json');
  let cachedMonthly = {};
  if (existsSync(cachedPath)) {
    try { cachedMonthly = JSON.parse(readFileSync(cachedPath, 'utf8')).monthly ?? {}; }
    catch { /* corrupt/missing cache — treat as empty */ }
  }

  const targetMonths = [];
  if (curMonth > 0) {
    targetMonths.push({
      start: new Date(Date.UTC(curYear, curMonth - 1, 1)),
      end:   new Date(Date.UTC(curYear, curMonth,     1)),
    });
  }
  targetMonths.push({
    start: new Date(Date.UTC(curYear, curMonth,     1)),
    end:   new Date(Date.UTC(curYear, curMonth + 1, 1)),
  });
  targetMonths.push({ start: pyStart, end: pyEnd });

  // Backfill any earlier YTD month (Jan … month-before-prev) that isn't cached yet.
  for (let m = 0; m < curMonth - 1; m++) {
    const key = `${curYear}-${String(m + 1).padStart(2, '0')}`;
    if (!cachedMonthly[key]) {
      console.log(`  Backfilling missing historical month: ${key}`);
      targetMonths.push({
        start: new Date(Date.UTC(curYear, m,     1)),
        end:   new Date(Date.UTC(curYear, m + 1, 1)),
      });
    }
  }

  console.log(`Fetching Freshdesk tickets (${targetMonths.length} targeted months, CSS groups)…`);
  const tickets = await fdFetchTickets(targetMonths, cssGroupIds);
  const tCreated = tickets.map(t => t.created_at).filter(Boolean).sort();
  console.log(`  → ${tickets.length} tickets, created ${tCreated[0]?.slice(0,10) ?? 'n/a'} – ${tCreated[tCreated.length-1]?.slice(0,10) ?? 'n/a'}`);

  const csatSince = pyStart.toISOString();
  console.log('Fetching Freshdesk CSAT…');
  let csat = [];
  try {
    csat = await fdGetAll('surveys/satisfaction_ratings', { created_since: csatSince });
    console.log(`  → ${csat.length} ratings`);
  } catch {
    try {
      csat = await fdGetAll('satisfaction_ratings', { created_since: csatSince });
      console.log(`  → ${csat.length} ratings`);
    } catch (e) { console.warn('  CSAT unavailable:', e.message); }
  }

  // Keep only CSAT for CSS-group tickets — a rating qualifies if its group_id is
  // a CSS group, or its ticket is one we fetched for a CSS group. Drops feedback
  // that leaked in from other teams (e.g. agents outside CSS).
  const cssTicketIdSet = new Set(tickets.map(t => t.id));
  const csatBefore = csat.length;
  csat = csat.filter(r =>
    (r.group_id != null && cssGroupIds.has(r.group_id)) ||
    (r.ticket_id != null && cssTicketIdSet.has(r.ticket_id))
  );
  console.log(`  → ${csat.length} CSS ratings (filtered out ${csatBefore - csat.length})`);

  console.log('Fetching CSS metrics from Google Sheets…');
  let cssSheetMetrics = null;
  try {
    cssSheetMetrics = await fetchCSSMetrics();
    console.log(`  → ${Object.keys(cssSheetMetrics?.monthly ?? {}).length} months of CSS metrics`);
  } catch (e) {
    console.warn('  CSS metrics fetch failed:', e.message);
  }

  console.log('Fetching Revenue Recovery from Google Sheets…');
  let revenueRecovery = null;
  try {
    revenueRecovery = await fetchRevenueRecovery();
    console.log(`  → ${Object.keys(revenueRecovery?.monthly ?? {}).length} months of recovery data`);
  } catch (e) {
    console.warn('  Revenue Recovery fetch failed:', e.message);
  }

  console.log(`Fetching Voiceflow transcripts (${VF_LOOKBACK_DAYS}d)…`);
  let sessions = [];
  try {
    sessions = await vfGetAll(VF_LOOKBACK_DAYS);
  } catch (e) {
    console.warn('  Voiceflow fetch failed:', e.message);
  }

  console.log('Building daily rollups…');
  const daily   = buildDailyRollups(tickets, sessions, csat, LOOKBACK_DAYS, generalGroupId);
  const monthly = buildMonthlyRollups(daily);

  // Merge stable historical months from cache for any month we did NOT fetch this run.
  const fetchedKeys = new Set(targetMonths.map(t => t.start.toISOString().slice(0, 7)));
  let merged = 0;
  for (const [k, v] of Object.entries(cachedMonthly)) {
    if (!fetchedKeys.has(k)) { monthly[k] = v; merged++; }
  }
  if (merged > 0) console.log(`  Merged ${merged} historical month(s) from cache`);

  // Safety net: a month must never regress from "has Freshdesk stats" to empty.
  // If a fetch comes back without FRT/FCR data for a month (page cap, timeout,
  // rate-limit, or a code change that broke the sweep), keep the good cached
  // Freshdesk stats instead of overwriting them with N/A. Fresh VF/CSAT/volume
  // numbers are left untouched — only the Freshdesk response/resolution fields
  // are restored from cache.
  const FD_STAT_FIELDS = [
    'frtSum', 'frtCount',
    'frt1Sum', 'frt1Count', 'frt2Sum', 'frt2Count',
    'frt3Sum', 'frt3Count', 'frt4Sum', 'frt4Count',
    'fcrResolved', 'fcrEligible', 'fcr2Resolved', 'fcr2Eligible',
    'slaHit', 'slaEligible',
  ];
  const hasTicketStats = m => !!m && ((m.frtCount ?? 0) > 0 || (m.fcrEligible ?? 0) > 0);
  let preserved = 0;
  for (const [k, cached] of Object.entries(cachedMonthly)) {
    const fresh = monthly[k];
    if (hasTicketStats(cached) && fresh && !hasTicketStats(fresh)) {
      for (const f of FD_STAT_FIELDS) fresh[f] = cached[f] ?? fresh[f] ?? 0;
      preserved++;
      console.log(`  ⚠ ${k}: fresh fetch had no FD stats — restored from cache`);
    }
  }
  if (preserved > 0) console.log(`  ⚠ Preserved Freshdesk stats for ${preserved} month(s) (fresh fetch came back empty)`);

  // Diagnostic: print ticket counts per month so we can verify against Freshdesk Analytics
  const curMoKey = new Date().toISOString().slice(0, 7);
  console.log('  Monthly ticket counts (last 6 months):');
  for (let i = 5; i >= 0; i--) {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
    const k = d.toISOString().slice(0, 7);
    console.log(`    ${k}: ${monthly[k]?.ticketsCreated ?? 0} tickets`);
  }

  // Diagnostic: Voiceflow sessions, engaged, AI-resolved, and cost per month + YTD
  console.log('  Monthly Voiceflow (sessions / engaged / aiResolved / cost):');
  let ytdSess = 0, ytdEng = 0, ytdAi = 0;
  for (let i = 5; i >= 0; i--) {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
    const k = d.toISOString().slice(0, 7);
    const m = monthly[k];
    if (!m) { console.log(`    ${k}: (no data)`); continue; }
    if (k.startsWith(`${new Date().getFullYear()}`)) { ytdSess += m.sessions; ytdEng += m.engaged; ytdAi += m.aiResolved; }
    const cost = (m.engaged * VF_COST).toFixed(2); // cost = engaged sessions only
    const rate = m.engaged > 0 ? (m.aiResolved / m.engaged * 100).toFixed(1) + '%' : 'n/a';
    console.log(`    ${k}: transcripts=${m.sessions} / engaged=${m.engaged} / aiResolved=${m.aiResolved} (${rate}) · $${cost}`);
  }
  console.log(`    YTD: transcripts=${ytdSess}, engaged=${ytdEng}, aiResolved=${ytdAi}, cost=$${(ytdEng * VF_COST).toFixed(2)} @ $${VF_COST}/engaged session`);

  console.log('Extracting Happy Thoughts from CSAT…');
  const happyThoughts = findHappyThoughts(csat);
  console.log(`  → ${happyThoughts.length} quotes`);

  console.log('Analyzing Persona Sentiment…');
  const personaSentiment = analyzePersonaSentiment(sessions);

  console.log('Selecting Interaction Examples…');
  const interactionExamples = await pickInteractionExamples(sessions);
  console.log(`  → ${interactionExamples.length} examples`);

  const out = {
    generatedAt:         new Date().toISOString(),
    dataEndDate:         DATA_END.toISOString(),
    lookbackDays:        LOOKBACK_DAYS,
    vfCostPerSession:    VF_COST,
    cssGroups:           CSS_GROUP_NAMES,
    priorityNames:       PRIORITY_NAMES,
    sampledMonths:       [],
    daily,
    monthly,
    happyThoughts,
    personaSentiment,
    interactionExamples,
    revenueRecovery,
    cssSheetMetrics,
  };

  const outPath = join(__dirname, 'css-data.json');
  writeFileSync(outPath, JSON.stringify(out));

  const totalTix = daily.reduce((s, d) => s + d.ticketsCreated, 0);
  const totalSes = daily.reduce((s, d) => s + d.sessions,       0);
  console.log(`\n✓ Wrote ${outPath}`);
  console.log(`  ${daily.length} days · ${totalTix} tickets · ${totalSes} VF sessions`);
  console.log(`  ${happyThoughts.length} happy thoughts · ${Object.keys(personaSentiment).length} persona summaries · ${interactionExamples.length} examples`);
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
