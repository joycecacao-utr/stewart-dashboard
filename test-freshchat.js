const KEY = process.env.FRESHCHAT_KEY;
if (!KEY) { console.error('FRESHCHAT_KEY not set'); process.exit(1); }

const BASE = 'https://universaltennis.freshchat.com/v2';
const headers = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

async function get(path) {
  const r = await fetch(`${BASE}/${path}`, { headers });
  console.log(`GET ${path} → ${r.status}`);
  const text = await r.text();
  if (!r.ok) { console.log('  Error:', text.slice(0, 300)); return null; }
  return JSON.parse(text);
}

async function post(path, body) {
  const r = await fetch(`${BASE}/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  console.log(`POST ${path} → ${r.status}`);
  const text = await r.text();
  if (!r.ok) { console.log('  Error:', text.slice(0, 300)); return null; }
  return JSON.parse(text);
}

async function main() {
  // Agents (confirmed working)
  const agents = await get('agents?page=1&items_per_page=3');
  if (agents) console.log('  agents count:', agents.agents?.length, '| sample keys:', Object.keys(agents.agents?.[0] ?? {}).join(', '));

  // Channels (inboxes) - needed to filter conversations
  const channels = await get('channels?page=1&items_per_page=5');
  if (channels) console.log('  channels sample:', JSON.stringify(channels).slice(0, 400));

  // Conversations with page param
  const convs = await get('conversations?page=1&items_per_page=3');
  if (convs) console.log('  conversations:', JSON.stringify(convs).slice(0, 400));

  // Reports/raw via POST
  const reportPost = await post('reports/raw', {
    start: '2026-06-01T00:00:00Z',
    end: '2026-06-11T23:59:59Z',
    type: 'conversation',
  });
  if (reportPost) console.log('  reports/raw POST:', JSON.stringify(reportPost).slice(0, 400));

  // Conversation metrics via POST
  const overviewPost = await post('reports/overview', {
    start: '2026-06-01T00:00:00Z',
    end: '2026-06-11T23:59:59Z',
  });
  if (overviewPost) console.log('  reports/overview POST:', JSON.stringify(overviewPost).slice(0, 400));

  // CSAT reports
  const csat = await get('reports/csat?start=2026-06-01T00:00:00Z&end=2026-06-11T23:59:59Z');
  if (csat) console.log('  csat:', JSON.stringify(csat).slice(0, 400));

  // Groups endpoint
  const groups = await get('groups?page=1&items_per_page=5');
  if (groups) console.log('  groups:', JSON.stringify(groups).slice(0, 400));
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
