#!/usr/bin/env node
// Runs in GitHub Actions. Fetches Freshdesk + Voiceflow data,
// computes all dashboard metrics, and writes docs/data.json.
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
const ROLLING_DAYS        = 30;
const COST_PER_SESSION    = 0.05;   // $/session — update to match billing
const DEFLECTION_SIGNAL   = null;   // e.g. 'resolved_by_stewart'
const ESCALATION_KEYWORDS = ['agent', 'human', 'transfer', 'escalat', 'handoff', 'live chat', 'representative'];

const INTENTS = {
  'Account / Login':    ['account', 'login', 'password', 'sign in', 'access'],
  'Ranking / UTR':      ['ranking', 'rank', 'rating', 'utr', 'score'],
  'Tournament':         ['tournament', 'event', 'register', 'sign up'],
  'Billing':            ['billing', 'payment', 'charge', 'invoice', 'refund'],
  'Technical Issue':    ['error', 'bug', 'not working', 'broken', 'problem'],
  'Match Results':      ['match', 'result', 'win', 'loss', 'played'],
  'Profile / Settings': ['profile', 'photo', 'name', 'update', 'settings'],
};

// ── Freshdesk helpers ─────────────────────────────────────
const FD_BASE = `https://${FD_DOMAIN}.freshdesk.com/api/v2`;
const FD_AUTH = 'Basic ' + Buffer.from(`${FD_KEY}:X`).toString('base64');

async function fdGet(path, params = {}) {
  const url = new URL(`${FD_BASE}/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const res = await fetch(url.toString(), { headers: { Authorization: FD_AUTH } });
  if (!res.ok) throw new Error(`Freshdesk ${path}: HTTP ${res.status}`);
  return res.json();
}

async function fdGetAll(path, params = {}, maxPages = 12) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await fdGet(path, { ...params, page, per_page: 100 });
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    if (data.length < 100) break;
    await new Promise(r => setTimeout(r, 200)); // gentle rate limiting
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

// ── Shared logic (mirrors index.html) ────────────────────
function isEscalated(t) {
  const blob = JSON.stringify(t).toLowerCase();
  return ESCALATION_KEYWORDS.some(kw => blob.includes(kw.toLowerCase()));
}

function isTrueDeflection(t) {
  if (DEFLECTION_SIGNAL) return JSON.stringify(t).toLowerCase().includes(DEFLECTION_SIGNAL.toLowerCase());
  return !isEscalated(t);
}

function inferIntent(query = '') {
  const q = query.toLowerCase();
  for (const [label, kws] of Object.entries(INTENTS)) {
    if (kws.some(kw => q.includes(kw))) return label;
  }
  return 'General Inquiry';
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

// ── Main ──────────────────────────────────────────────────
async function main() {
  console.log('Fetching data…');

  const since30 = daysAgo(ROLLING_DAYS);

  const [groups, allTickets, vf24h, vf30d] = await Promise.all([
    fdGet('groups'),
    fdGetAll('tickets', { updated_since: since30, include: 'stats' }),
    vfTranscripts(24),
    vfTranscripts(ROLLING_DAYS * 24),
  ]);

  // General group
  const generalGroup = groups.find(g => g.name === GENERAL_GROUP_NAME);
  if (!generalGroup) throw new Error(`Group "${GENERAL_GROUP_NAME}" not found`);
  const generalId = generalGroup.id;
  const generalTickets = allTickets.filter(t => t.group_id === generalId);

  // Source distribution
  const stewartTix = allTickets.filter(t => (t.tags || []).includes(STEWART_TAG));
  const chatTix    = allTickets.filter(t => t.source === 7 && !(t.tags || []).includes(STEWART_TAG));
  const emailTix   = allTickets.filter(t => t.source === 1);
  const otherTix   = allTickets.filter(t =>
    !(t.tags || []).includes(STEWART_TAG) && t.source !== 7 && t.source !== 1
  );
  const sourceData = {
    stewart: stewartTix.length,
    chat:    chatTix.length,
    email:   emailTix.length,
    other:   otherTix.length,
    total:   allTickets.length,
  };

  // VF sessions
  const sessions24h = vf24h?.length ?? null;
  const sessions30d = vf30d?.length ?? null;
  const avgSessionsPerDay = sessions30d !== null ? sessions30d / ROLLING_DAYS : null;
  const cost24h    = sessions24h !== null ? (sessions24h * COST_PER_SESSION).toFixed(2) : null;
  const cost30dAvg = avgSessionsPerDay !== null ? (avgSessionsPerDay * COST_PER_SESSION).toFixed(2) : null;

  // Deflection / containment
  let deflectionRate = null, containmentRate = null, handoffRate = null;
  const handoffPctByHour = Array(24).fill(0);
  let intentData = [];

  if (vf30d && sessions30d > 0) {
    const deflected = vf30d.filter(isTrueDeflection);
    const escalated = vf30d.filter(isEscalated);
    deflectionRate  = (deflected.length / sessions30d * 100).toFixed(1);
    handoffRate     = (escalated.length / sessions30d * 100).toFixed(1);
    containmentRate = ((1 - escalated.length / sessions30d) * 100).toFixed(1);

    const byHour = Array(24).fill(null).map(() => ({ s: 0, h: 0 }));
    vf30d.forEach(s => {
      const hr = new Date(s.createdAt || s.updatedAt || Date.now()).getHours();
      byHour[hr].s++;
      if (isEscalated(s)) byHour[hr].h++;
    });
    byHour.forEach((b, i) => { handoffPctByHour[i] = b.s > 0 ? +(b.h / b.s * 100).toFixed(1) : 0; });

    const intentMap = {};
    vf30d.forEach(s => {
      const turns = s.turns || [];
      const first = turns.find(t => t.type === 'request');
      const query = first?.payload?.payload?.query || first?.payload?.query || first?.payload?.message || '';
      const label = inferIntent(query);
      if (!intentMap[label]) intentMap[label] = { total: 0, contained: 0 };
      intentMap[label].total++;
      if (isTrueDeflection(s)) intentMap[label].contained++;
    });
    intentData = Object.entries(intentMap)
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 8)
      .map(([label, v]) => ({ label, rate: +(v.contained / v.total * 100).toFixed(1), total: v.total }));
  }

  // FCR
  const resolvedGeneral = generalTickets.filter(t => t.status === 4 || t.status === 5);
  const fcrTickets = resolvedGeneral.filter(t => (t.stats?.reopen_count ?? 0) === 0);
  const fcrRate = resolvedGeneral.length > 0
    ? (fcrTickets.length / resolvedGeneral.length * 100).toFixed(1)
    : null;

  // FRT
  const frtSamples = generalTickets
    .filter(t => t.stats?.first_responded_at && t.created_at)
    .map(t => (new Date(t.stats.first_responded_at) - new Date(t.created_at)) / 60000)
    .filter(v => v > 0 && v < 20160);
  const avgFRT = frtSamples.length > 0
    ? frtSamples.reduce((a, b) => a + b, 0) / frtSamples.length
    : null;

  // AHT
  const ahtSamples = generalTickets
    .filter(t => t.stats?.resolved_at && t.stats?.first_responded_at)
    .map(t => (new Date(t.stats.resolved_at) - new Date(t.stats.first_responded_at)) / 60000)
    .filter(v => v > 0 && v < 20160);
  const avgAHT = ahtSamples.length > 0
    ? ahtSamples.reduce((a, b) => a + b, 0) / ahtSamples.length
    : null;

  // Tickets per shift
  const shiftsIn30d = (ROLLING_DAYS * 24) / SHIFT_HOURS;
  const ticketsPerShift = (resolvedGeneral.length / shiftsIn30d).toFixed(1);

  // Repeat contact
  const repeatSet = new Set();
  const closedTickets = allTickets
    .filter(t => (t.status === 4 || t.status === 5) && t.stats?.resolved_at)
    .map(t => ({ id: t.id, reqId: t.requester_id, closedAt: new Date(t.stats.resolved_at), reopen: t.stats?.reopen_count ?? 0 }));
  closedTickets.forEach(ct => {
    if (ct.reopen > 0) { repeatSet.add(ct.id); return; }
    const hit = allTickets.find(t =>
      t.requester_id === ct.reqId &&
      t.id !== ct.id &&
      new Date(t.created_at) > ct.closedAt &&
      new Date(t.created_at) <= new Date(ct.closedAt.getTime() + 7 * 86400000)
    );
    if (hit) repeatSet.add(ct.id);
  });
  const repeatRate = closedTickets.length > 0
    ? (repeatSet.size / closedTickets.length * 100).toFixed(1)
    : null;

  // Backlog trend
  const backlogByDay = [];
  for (let i = 6; i >= 0; i--) {
    const dayStart = new Date();
    dayStart.setDate(dayStart.getDate() - i);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart.getTime() + 86400000);
    const open = allTickets.filter(t => {
      const created  = new Date(t.created_at);
      const resolved = t.stats?.resolved_at ? new Date(t.stats.resolved_at) : null;
      return created < dayEnd && (!resolved || resolved >= dayStart);
    }).length;
    backlogByDay.push({
      label: dayStart.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
      count: open,
    });
  }

  const output = {
    generatedAt:      new Date().toISOString(),
    deflectionIsEstimate: !DEFLECTION_SIGNAL,
    sourceData,
    sessions24h,
    avgSessionsPerDay,
    cost24h,
    cost30dAvg,
    costPerSession:   COST_PER_SESSION,
    deflectionRate,
    containmentRate,
    handoffRate,
    fcrRate,
    avgFRT,
    avgAHT,
    ticketsPerShift,
    repeatRate,
    handoffPctByHour,
    backlogByDay,
    stewartFRT:       0.5,
    intentData,
  };

  const outPath = join(process.cwd(), 'docs', 'data.json');
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`✓ Wrote ${outPath}`);
  console.log(`  Tickets: ${allTickets.length} total, ${generalTickets.length} General`);
  console.log(`  VF sessions: ${sessions24h ?? 'n/a'} (24h) / ${sessions30d ?? 'n/a'} (30d)`);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
