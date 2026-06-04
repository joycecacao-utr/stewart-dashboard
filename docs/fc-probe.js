#!/usr/bin/env node
// fc-probe.js — TEMPORARY. Discover the Freshchat API: confirm auth/base URL,
// then explore endpoints for conversation volume by date + CSAT field names.
// Reads FRESHCHAT_KEY from env (GitHub secret). Delete after we confirm shapes.

const KEY = process.env.FRESHCHAT_KEY;
if (!KEY) { console.error('FRESHCHAT_KEY not set'); process.exit(1); }
const BASE = process.env.FRESHCHAT_URL || 'https://api.freshchat.com/v2';
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
    console.log(`\n=== ${label} ===\n${method} ${url}\nHTTP ${res.status}\n${text.slice(0, 1400)}`);
    try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, json: null }; }
  } catch (e) { console.log(`\n=== ${label} ===\n${method} ${url}\nTHREW: ${e.message}`); return {}; }
}

// 1) Auth / base check
await probe('agents', 'GET', '/agents?items_per_page=1');
// 2) Conversation listing attempts
await probe('conversations (plain)', 'GET', '/conversations');
await probe('conversations search', 'POST', '/conversations/search', { query: {} });
// 3) Reports / analytics (token has reports:extract, reports:read scopes)
await probe('reports list', 'GET', '/reports');
await probe('metrics', 'GET', '/metrics');
// 4) Outbound + channels for orientation
await probe('channels', 'GET', '/channels');
