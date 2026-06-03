#!/usr/bin/env node
// fetch-data.js — runs in GitHub Actions, writes docs/data.json
// Node 20+ required (uses built-in fetch).

import { writeFileSync } from 'fs';
import { join } from 'path';

// ── Config ────────────────────────────────────────────────
const FD_KEY    = process.env.FRESHDESK_KEY;
const VF_KEY    = process.env.VOICEFLOW_KEY;
const FD_DOMAIN = process.env.FRESHDESK_DOMAIN || 'universaltennis';
const VF_PROJECT = '69ebdbdd003c5c7a49123a84';

const STEWART_TAG         = 'Stewart_AI';
const GENERAL_GROUP_NAME  = 'General';
const SHIFT_HOURS         = 10;
const COST_PER_SESSION    = 0.05;
const DEFLECTION_SIGNAL   = null; // set to e.g. 'resolved_by_stewart' once configured
const ESCALATION_KEYWORDS = ['agent', 'human', 'transfer', 'escalat', 'handoff', 'live chat', 'representative'];

const SUBJECT_CATEGORIES = {
  'Account / Login':    ['account', 'login', 'password', 'sign in', 'access'],
  'Ranking / UTR':      ['ranking', 'rank', 'utr', 'rating', 'score'],
  'Tournament':         ['tournament', 'event', 'register', 'sign up'],
  'Billing':            ['billing', 'payment', 'charge', 'refund', 'invoice'],
  'Technical Issue':    ['error', 'bug', 'not working', 'broken', 'issue'],
  'Match Results':      ['match', 'result', 'score', 'win', 'loss'],
  'Profile / Settings': ['profile', 'photo', 'name', 'update', 'settings'],
};

// ── Freshdesk helpers ─────────────────────────────────────
const FD_AUTH = 'Basic ' + Buffer.from(`${FD_KEY}:X`).toString('base64');

async function fdGet(path, params = {}) {
  const url = new URL(`https://${FD_DOMAIN}.freshdesk.com/api/v2/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const res = await fetch(url.toString(), { headers: { Authorization: FD_AUTH } });
  if (!res.ok) throw new Error(`Freshdesk ${path}: HTTP ${res.status}`);
  return res.json();
}

async function fdGetAll(path, params = {}, maxPages = 20) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await fdGet(path, { ...params, page, per_page: 100 });
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    if (data.length < 100) break;
    await sleep(300); // gentle rate limiting
  }
  return all;
}

// ── Voiceflow helpers ─────────────────────────────────────
async function vfTranscripts(hours) {
  const start = new Date(Date.now() - hours * 3600000).toISOString();
  try {
    const url = new URL(`https://api.voiceflow.com/v2/transcripts/${VF_PROJECT}`);
    url.searchParams.set('range[start]', start);
    const res = await fetch(url.toString(), { headers: { Authorization: VF_KEY } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data) ? data : (data.data ?? data.items ?? []);
  } catch (e) {
    console.warn(`Voiceflow transcripts (${hours}h) failed:`, e.message);
    return null;
  }
}

// ── Shared helpers ────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

function isEscalated(t) {
  const blob = JSON.stringify(t).toLowerCase();
  return ESCALATION_KEYWORDS.some(kw => blob.includes(kw.toLowerCase()));
}

function isTrueDeflection(t) {
  if (DEFLECTION_SIGNAL) return JSON.stringify(t).toLowerCase().includes(DEFLECTION_SIGNAL.toLowerCase());
  return !isEscalated(t);
}

function getCategory(ticket) {
  if (ticket.type && typeof ticket.type === 'string' && ticket.type.trim()) return ticket.type.trim();
  const tags = (ticket.tags || []).filter(t => t !== STEWART_TAG);
  if (tags.length > 0) return tags[0];
  const subject = (ticket.subject || '').toLowerCase();
  for (const [cat, kws] of Object.entries(SUBJECT_CATEGORIES)) {
    if (kws.some(kw => subject.includes(kw))) return cat;
  }
  return 'General Inquiry';
}

// Group items into time buckets appropriate for the range
function groupByPeriod(items, getDate, rangeKey) {
  const now = new Date();

  if (rangeKey === '24h') {
    const buckets = Array.from({ length: 24 }, (_, i) => {
      const ts = new Date(now - (23 - i) * 3600000);
      ts.setMinutes(0, 0, 0);
      return { label: `${String(ts.getHours()).padStart(2, '0')}:00`, items: [], ts };
    });
    items.forEach(item => {
      const d = getDate(item);
      const bucket = buckets.findIndex((b, i) => {
        const next = buckets[i + 1]?.ts ?? new Date(now.getTime() + 3600000);
        return d >= b.ts && d < next;
      });
      if (bucket >= 0) buckets[bucket].items.push(item);
    });
    return buckets;
  }

  if (rangeKey === '7d') {
    const buckets = Array.from({ length: 7 }, (_, i) => {
      const ts = new Date(now);
      ts.setDate(ts.getDate() - (6 - i));
      ts.setHours(0, 0, 0, 0);
      return { label: ts.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }), items: [], ts };
    });
    items.forEach(item => {
      const d = getDate(item);
      const idx = buckets.findIndex((b, i) => {
        const next = new Date(b.ts.getTime() + 86400000);
        return d >= b.ts && d < next;
      });
      if (idx >= 0) buckets[idx].items.push(item);
    });
    return buckets;
  }

  if (rangeKey === '30d') {
    const buckets = Array.from({ length: 30 }, (_, i) => {
      const ts = new Date(now);
      ts.setDate(ts.getDate() - (29 - i));
      ts.setHours(0, 0, 0, 0);
      return { label: ts.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), items: [], ts };
    });
    items.forEach(item => {
      const d = getDate(item);
      const idx = buckets.findIndex((b, i) => {
        const next = new Date(b.ts.getTime() + 86400000);
        return d >= b.ts && d < next;
      });
      if (idx >= 0) buckets[idx].items.push(item);
    });
    return buckets;
  }

  // year → 12 monthly buckets
  const buckets = Array.from({ length: 12 }, (_, i) => {
    const ts = new Date(now.getFullYear(), now.getMonth() - (11 - i), 1);
    return { label: ts.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }), items: [], ts };
  });
  items.forEach(item => {
    const d = getDate(item);
    const idx = buckets.findIndex((b, i) => {
      const next = buckets[i + 1]?.ts ?? new Date(now.getFullYear(), now.getMonth() + 1, 1);
      return d >= b.ts && d < next;
    });
    if (idx >= 0) buckets[idx].items.push(item);
  });
  return buckets;
}

// ── Core metrics computation (per range) ─────────────────
function computeRangeMetrics(allTickets, sessions, generalId, rangeKey, hours) {
  const since = new Date(Date.now() - hours * 3600000);
  const tickets = allTickets.filter(t => new Date(t.created_at) >= since || new Date(t.updated_at) >= since);
  const filteredSessions = sessions
    ? sessions.filter(s => new Date(s.createdAt || s.updatedAt || 0) >= since)
    : null;

  const general = tickets.filter(t => t.group_id === generalId);

  // ── Source distribution ──────────────────────────────
  const stewartTix = tickets.filter(t => (t.tags || []).includes(STEWART_TAG));
  const chatTix    = tickets.filter(t => t.source === 7 && !(t.tags || []).includes(STEWART_TAG));
  const emailTix   = tickets.filter(t => t.source === 1);
  const otherTix   = tickets.filter(t => !(t.tags || []).includes(STEWART_TAG) && t.source !== 7 && t.source !== 1);
  const sourceData = {
    stewart: stewartTix.length, chat: chatTix.length,
    email: emailTix.length, other: otherTix.length, total: tickets.length,
  };

  // ── VF session metrics ───────────────────────────────
  const sessionCount = filteredSessions?.length ?? null;
  const cost = sessionCount !== null ? (sessionCount * COST_PER_SESSION).toFixed(2) : null;

  let deflectionRate = null, escalationRate = null;
  if (filteredSessions && filteredSessions.length > 0) {
    deflectionRate = (filteredSessions.filter(isTrueDeflection).length / filteredSessions.length * 100).toFixed(1);
    escalationRate = (filteredSessions.filter(isEscalated).length / filteredSessions.length * 100).toFixed(1);
  }

  // ── General queue metrics ────────────────────────────
  const resolved = general.filter(t => t.status === 4 || t.status === 5);
  const fcrRate = resolved.length > 0
    ? (resolved.filter(t => (t.stats?.reopen_count ?? 0) === 0).length / resolved.length * 100).toFixed(1)
    : null;

  const frtSamples = general
    .filter(t => t.stats?.first_responded_at && t.created_at)
    .map(t => (new Date(t.stats.first_responded_at) - new Date(t.created_at)) / 60000)
    .filter(v => v > 0 && v < 20160);
  const avgFRT = frtSamples.length > 0 ? frtSamples.reduce((a, b) => a + b, 0) / frtSamples.length : null;

  const ahtSamples = general
    .filter(t => t.stats?.resolved_at && t.stats?.first_responded_at)
    .map(t => (new Date(t.stats.resolved_at) - new Date(t.stats.first_responded_at)) / 60000)
    .filter(v => v > 0 && v < 20160);
  const avgAHT = ahtSamples.length > 0 ? ahtSamples.reduce((a, b) => a + b, 0) / ahtSamples.length : null;

  const shiftsInPeriod = hours / SHIFT_HOURS;
  const ticketsPerShift = shiftsInPeriod > 0 ? (resolved.length / shiftsInPeriod).toFixed(1) : null;

  // ── Repeat contact ───────────────────────────────────
  const repeatSet = new Set();
  const closedTix = tickets
    .filter(t => (t.status === 4 || t.status === 5) && t.stats?.resolved_at)
    .map(t => ({ id: t.id, reqId: t.requester_id, closedAt: new Date(t.stats.resolved_at), reopen: t.stats?.reopen_count ?? 0 }));
  closedTix.forEach(ct => {
    if (ct.reopen > 0) { repeatSet.add(ct.id); return; }
    const hit = tickets.find(t =>
      t.requester_id === ct.reqId && t.id !== ct.id &&
      new Date(t.created_at) > ct.closedAt &&
      new Date(t.created_at) <= new Date(ct.closedAt.getTime() + 7 * 86400000)
    );
    if (hit) repeatSet.add(ct.id);
  });
  const repeatRate = closedTix.length > 0 ? (repeatSet.size / closedTix.length * 100).toFixed(1) : null;

  // ── Ticket Volume Trend ──────────────────────────────
  const createdInRange = tickets.filter(t => new Date(t.created_at) >= since);
  const volBuckets = groupByPeriod(createdInRange, t => new Date(t.created_at), rangeKey);
  const ticketVolumeTrend = volBuckets.map(b => ({ label: b.label, count: b.items.length }));

  // ── Top 5 Categories ─────────────────────────────────
  const catMap = {};
  tickets.forEach(t => { const c = getCategory(t); catMap[c] = (catMap[c] || 0) + 1; });
  const topCategories = Object.entries(catMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([label, count]) => ({ label, count }));

  // ── Peak Volume by Hour ──────────────────────────────
  const peakVolumeByHour = Array(24).fill(0);
  createdInRange.forEach(t => { peakVolumeByHour[new Date(t.created_at).getHours()]++; });

  // ── Escalation Rate Trend ────────────────────────────
  let escalationTrend = [];
  if (filteredSessions && filteredSessions.length > 0) {
    const eBuckets = groupByPeriod(
      filteredSessions,
      s => new Date(s.createdAt || s.updatedAt || Date.now()),
      rangeKey
    );
    escalationTrend = eBuckets.map(b => ({
      label: b.label,
      rate: b.items.length > 0 ? +(b.items.filter(isEscalated).length / b.items.length * 100).toFixed(1) : 0,
      sessions: b.items.length,
    }));
  }

  // ── 7-day Backlog ────────────────────────────────────
  const backlogByDay = [];
  for (let i = 6; i >= 0; i--) {
    const dayStart = new Date(); dayStart.setDate(dayStart.getDate() - i); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart.getTime() + 86400000);
    const open = allTickets.filter(t => {
      const created  = new Date(t.created_at);
      const resolved = t.stats?.resolved_at ? new Date(t.stats.resolved_at) : null;
      return created < dayEnd && (!resolved || resolved >= dayStart);
    }).length;
    backlogByDay.push({ label: dayStart.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }), count: open });
  }

  return {
    sourceData, sessionCount, cost, deflectionRate, escalationRate,
    fcrRate, avgFRT, avgWaitTime: avgFRT, avgAHT, ticketsPerShift, repeatRate,
    ticketVolumeTrend, topCategories, peakVolumeByHour, escalationTrend, backlogByDay,
    ticketCount: tickets.length,
  };
}

// ── Main ──────────────────────────────────────────────────
async function main() {
  if (!FD_KEY) throw new Error('FRESHDESK_KEY env var not set');
  if (!VF_KEY) throw new Error('VOICEFLOW_KEY env var not set');

  console.log('Fetching Freshdesk groups...');
  const groups = await fdGet('groups');
  const generalGroup = groups.find(g => g.name === GENERAL_GROUP_NAME);
  if (!generalGroup) throw new Error(`Group "${GENERAL_GROUP_NAME}" not found`);
  const generalId = generalGroup.id;

  console.log('Fetching Freshdesk tickets (365d window, up to 2000)...');
  const allTickets = await fdGetAll('tickets', { updated_since: daysAgo(365), include: 'stats' }, 20);
  console.log(`  → ${allTickets.length} tickets`);

  console.log('Fetching Voiceflow transcripts...');
  const [vf30d, vfYear] = await Promise.all([
    vfTranscripts(30 * 24),
    vfTranscripts(365 * 24),
  ]);
  console.log(`  → ${vf30d?.length ?? 'n/a'} sessions (30d),  ${vfYear?.length ?? 'n/a'} sessions (year)`);

  console.log('Computing metrics for all ranges...');
  const ranges = {};
  for (const [key, hours, vf] of [
    ['24h',  24,          vf30d ],
    ['7d',   7 * 24,      vf30d ],
    ['30d',  30 * 24,     vf30d ],
    ['year', 365 * 24,    vfYear],
  ]) {
    ranges[key] = computeRangeMetrics(allTickets, vf, generalId, key, hours);
    console.log(`  ${key}: ${ranges[key].ticketCount} tickets, ${ranges[key].sessionCount ?? 'n/a'} sessions`);
  }

  const outPath = join(process.cwd(), 'docs', 'data.json');
  writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    deflectionIsEstimate: !DEFLECTION_SIGNAL,
    costPerSession: COST_PER_SESSION,
    ranges,
  }, null, 2));

  console.log(`\n✓ Wrote ${outPath}`);
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
