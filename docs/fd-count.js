#!/usr/bin/env node
// fd-count.js — TEMPORARY. Verify the Freshchat-via-Freshdesk filter: how many
// tickets in the last 7 days have a subject starting with "Conversation".
// Reads FRESHDESK_KEY from env. Delete after verification.

const FD_KEY    = process.env.FRESHDESK_KEY;
const FD_DOMAIN = process.env.FRESHDESK_DOMAIN || 'universaltennis';
if (!FD_KEY) { console.error('FRESHDESK_KEY not set'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const AUTH  = 'Basic ' + Buffer.from(`${FD_KEY}:X`).toString('base64');

async function fdGet(path, params = {}) {
  const url = new URL(`https://${FD_DOMAIN}.freshdesk.com/api/v2/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  for (let i = 0; i < 5; i++) {
    const res = await fetch(url, { headers: { Authorization: AUTH } });
    if (res.status === 429) { await sleep(((+res.headers.get('retry-after') || 2) + 1) * 1000); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  throw new Error('rate-limited');
}

const since = new Date(Date.now() - 7 * 86400000).toISOString();
console.log('Counting tickets created/updated since', since);

const seen = new Set(); const all = [];
for (let page = 1; page <= 50; page++) {
  const data = await fdGet('tickets', { updated_since: since, per_page: 100, page, order_by: 'updated_at', order_type: 'asc' });
  if (!Array.isArray(data) || data.length === 0) break;
  for (const t of data) if (!seen.has(t.id)) { seen.add(t.id); all.push(t); }
  if (data.length < 100) break;
  await sleep(300);
}

const isConv = s => (s ?? '').trim().toLowerCase().startsWith('conversation');
const created7d = all.filter(t => new Date(t.created_at) >= new Date(since));
const conv = created7d.filter(t => isConv(t.subject));

console.log(`\nTotal tickets touched (last 7d window): ${all.length}`);
console.log(`Tickets CREATED in last 7d:            ${created7d.length}`);
console.log(`  └─ subject starts with "Conversation": ${conv.length}`);
console.log('\nSample "Conversation" subjects:');
conv.slice(0, 15).forEach(t => console.log(`  • ${JSON.stringify(t.subject)}  (#${t.id}, ${t.created_at})`));
console.log('\nSample NON-matching subjects (for contrast):');
created7d.filter(t => !isConv(t.subject)).slice(0, 8).forEach(t => console.log(`  • ${JSON.stringify(t.subject)}`));
