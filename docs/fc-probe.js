#!/usr/bin/env node
// fc-probe.js — TEMPORARY. Round 5: `event` is the right field & raw-export is
// enabled (it validates the value), but the exact event string is elusive. Try
// the remaining documented Freshchat Raw Data API event names. Last guessing
// round — if none hit, we hand off to the account admin for the exact name.
// Reads FRESHCHAT_KEY from env. Delete after we confirm shapes.

const KEY = process.env.FRESHCHAT_KEY;
if (!KEY) { console.error('FRESHCHAT_KEY not set'); process.exit(1); }
const BASE = process.env.FRESHCHAT_URL || 'https://universaltennis.freshchat.com/v2';
const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' };

const end   = new Date().toISOString();
const start = new Date(Date.now() - 7 * 86400000).toISOString();
console.log('BASE', BASE, '· range', start, '→', end);

async function probe(ev) {
  const url = `${BASE}/reports/raw`;
  try {
    const res = await fetch(url, { method: 'POST', headers: H,
      body: JSON.stringify({ event: ev, format: 'json', start, end }) });
    const text = await res.text();
    const hit = !text.includes('No matching event name');
    console.log(`\n=== ${ev} ===${hit ? '  <-- ACCEPTED' : ''}\nHTTP ${res.status}\n${text.slice(0, 1400)}`);
  } catch (e) { console.log(`\n=== ${ev} ===\nTHREW ${e.message}`); }
}

const candidates = [
  'Conversation Assigned', 'Conversation Closed', 'Conversation Deleted',
  'Message Sent', 'Message Received', 'Messages Sent', 'Messages Received',
  'First Response', 'Agent Responded', 'Agent First Response', 'Resolution',
  'Bot', 'Bot Session', 'Bot Sessions', 'Deflection', 'Ticket',
  'Conversation', 'CONVERSATION', 'conversations', 'conversation_created',
];
for (const ev of candidates) await probe(ev);
