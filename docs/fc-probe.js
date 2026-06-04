#!/usr/bin/env node
// fc-probe.js — TEMPORARY. Round 2: the conversations endpoints are disabled for
// this app (403), but /reports exists and rejects GET with 405 → it's a POST.
// Probe the Freshchat Analytics "Reports Extract" API for daily conversation
// volume + CSAT. Reads FRESHCHAT_KEY from env. Delete after we confirm shapes.

const KEY = process.env.FRESHCHAT_KEY;
if (!KEY) { console.error('FRESHCHAT_KEY not set'); process.exit(1); }
const BASE = process.env.FRESHCHAT_URL || 'https://universaltennis.freshchat.com/v2';
const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' };

const endD   = new Date();
const startD = new Date(Date.now() - 7 * 86400000);
const end    = endD.toISOString();
const start  = startD.toISOString();
const dayStr = d => d.toISOString().slice(0, 10);
console.log('BASE', BASE, '· range', start, '→', end);

async function probe(label, method, path, body) {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  try {
    const opts = { method, headers: H };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    const text = await res.text();
    console.log(`\n=== ${label} ===\n${method} ${url}\nHTTP ${res.status}\n${text.slice(0, 1600)}`);
    try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, json: null }; }
  } catch (e) { console.log(`\n=== ${label} ===\n${method} ${url}\nTHREW: ${e.message}`); return {}; }
}

// Freshchat Analytics Extract API — async job: POST creates an extract, returns
// a link/id you poll. Try the documented shapes for raw conversation data.
const fromS = dayStr(startD), toS = dayStr(endD);

await probe('reports raw (created/conv)', 'POST', '/reports/raw', {
  metric_set: 'conversations',
  start: fromS, end: toS,
});
await probe('reports extract', 'POST', '/reports/extract', {
  start: fromS, end: toS,
});
await probe('reports raw event-based', 'POST', '/reports/raw', {
  event: 'Conversation Created',
  pivots: [{ entity: 'conversation', metric: 'count' }],
  start_time: start, end_time: end,
  group_by: ['day'],
});
// Some accounts expose a measures/metrics listing to discover valid metric names
await probe('reports measures', 'GET', '/reports/measures');
await probe('reports schema', 'GET', '/reports/schema');
// CSAT survey responses
await probe('csat list', 'GET', `/conversations/csat?start=${fromS}&end=${toS}`);
await probe('csat reports raw', 'POST', '/reports/raw', {
  metric_set: 'csat',
  start: fromS, end: toS,
});
