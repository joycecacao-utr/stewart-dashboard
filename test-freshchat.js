const KEY = process.env.FRESHCHAT_KEY;
if (!KEY) { console.error('FRESHCHAT_KEY not set'); process.exit(1); }

const BASE = 'https://universaltennis.freshchat.com/v2';
const headers = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

async function get(path) {
  const r = await fetch(`${BASE}/${path}`, { headers });
  console.log(`GET ${path} → ${r.status}`);
  const text = await r.text();
  if (!r.ok) { console.log('  Error:', text.slice(0, 200)); return null; }
  return JSON.parse(text);
}

async function main() {
  // Conversations list
  const convs = await get('conversations?page=1&items_per_page=3');
  if (convs) console.log('  conversations sample keys:', Object.keys(convs.conversations?.[0] ?? {}).join(', '));

  // Reports — conversation metrics
  const report = await get('reports/raw?start=2026-06-01T00:00:00Z&end=2026-06-11T23:59:59Z&type=conversation');
  if (report) console.log('  report sample:', JSON.stringify(report).slice(0, 300));

  // CSAT surveys
  const csat = await get('surveys');
  if (csat) console.log('  surveys:', JSON.stringify(csat).slice(0, 300));

  // Conversation metrics (summary)
  const metrics = await get('reports/overview');
  if (metrics) console.log('  overview:', JSON.stringify(metrics).slice(0, 300));

  // Agents (to understand structure)
  const agents = await get('agents?page=1&items_per_page=3');
  if (agents) console.log('  agents sample keys:', Object.keys(agents.agents?.[0] ?? {}).join(', '));
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
