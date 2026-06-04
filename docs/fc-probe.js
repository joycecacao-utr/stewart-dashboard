#!/usr/bin/env node
// fc-probe.js — TEMPORARY. Round 3: POST /v2/reports/raw is the right endpoint
// (Freshchat async Raw Data Export API). Structure is accepted; we just need a
// valid `event` name (round 2 returned error_code 5 "No matching event name").
// Probe candidate event names + the async job/link response shape.
// Reads FRESHCHAT_KEY from env. Delete after we confirm shapes.

const KEY = process.env.FRESHCHAT_KEY;
if (!KEY) { console.error('FRESHCHAT_KEY not set'); process.exit(1); }
const BASE = process.env.FRESHCHAT_URL || 'https://universaltennis.freshchat.com/v2';
const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' };

const end   = new Date().toISOString();
const start = new Date(Date.now() - 7 * 86400000).toISOString();
console.log('BASE', BASE, '· range', start, '→', end);

async function probe(label, body) {
  const url = `${BASE}/reports/raw`;
  try {
    const res = await fetch(url, { method: 'POST', headers: H, body: JSON.stringify(body) });
    const text = await res.text();
    console.log(`\n=== ${label} ===\nPOST ${url}\nbody ${JSON.stringify(body)}\nHTTP ${res.status}\n${text.slice(0, 1200)}`);
    try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, json: null }; }
  } catch (e) { console.log(`\n=== ${label} ===\nTHREW ${e.message}`); return {}; }
}

// Candidate event names from Freshchat Raw Data Export API docs.
const candidates = [
  'Conversations', 'Conversation', 'Messages', 'Message',
  'Conversation Created', 'Conversation Resolved', 'Conversation Reopened',
  'Agent Activity', 'Agent Availability', 'Agent Intelliassign Activities',
  'CSAT', 'Conversation CSAT', 'CSAT Response', 'Customer Satisfaction',
];
for (const ev of candidates) {
  await probe(ev, { event: ev, format: 'json', start, end });
}
