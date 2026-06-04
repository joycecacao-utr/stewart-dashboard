#!/usr/bin/env node
// fc-probe.js — TEMPORARY. Round 4: stop guessing event names — try to ENUMERATE
// valid ones. GET /reports/raw (and variants) often returns the allowed event
// list or a usage hint. Also retry exact documented names + a no-event POST.
// Reads FRESHCHAT_KEY from env. Delete after we confirm shapes.

const KEY = process.env.FRESHCHAT_KEY;
if (!KEY) { console.error('FRESHCHAT_KEY not set'); process.exit(1); }
const BASE = process.env.FRESHCHAT_URL || 'https://universaltennis.freshchat.com/v2';
const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' };

const end   = new Date().toISOString();
const start = new Date(Date.now() - 7 * 86400000).toISOString();
console.log('BASE', BASE, '· range', start, '→', end);

async function probe(label, method, path, body) {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  try {
    const opts = { method, headers: H };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    const text = await res.text();
    console.log(`\n=== ${label} ===\n${method} ${url}\nHTTP ${res.status}\n${text.slice(0, 1800)}`);
  } catch (e) { console.log(`\n=== ${label} ===\nTHREW ${e.message}`); }
}

// 1) Discovery: ask the API which events it supports
await probe('GET reports/raw (usage?)',     'GET',  '/reports/raw');
await probe('GET reports/raw/events',        'GET',  '/reports/raw/events');
await probe('GET reports/events',            'GET',  '/reports/events');
await probe('GET reports/raw/metrics',       'GET',  '/reports/raw/metrics');
await probe('POST reports/raw (no event)',   'POST', '/reports/raw', { start, end });

// 2) A few more exact documented names with single-word + plural variants
for (const ev of ['Group', 'Groups', 'IntelliAssign', 'Conversation Lifecycle',
                  'Conversation Properties', 'Customer', 'Customers', 'Billing']) {
  await probe(ev, 'POST', '/reports/raw', { event: ev, format: 'json', start, end });
}

// 3) Maybe the field is `event_name` not `event`
await probe('event_name=Conversations', 'POST', '/reports/raw',
  { event_name: 'Conversations', format: 'json', start, end });
