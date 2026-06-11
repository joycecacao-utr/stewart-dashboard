const KEY = process.env.FRESHCHAT_KEY;
if (!KEY) { console.error('FRESHCHAT_KEY not set'); process.exit(1); }

const headers = {
  Authorization: `Bearer ${KEY}`,
  'Content-Type': 'application/json',
};

async function get(path) {
  const r = await fetch(`https://universaltennis.freshchat.com/v2/${path}`, { headers });
  console.log(`GET ${path} → ${r.status}`);
  if (!r.ok) { console.error(await r.text()); return null; }
  return r.json();
}

async function main() {
  // Check account info
  const account = await get('accounts/me');
  if (account) console.log('Account:', JSON.stringify(account).slice(0, 200));

  // List conversations (recent)
  const convs = await get('conversations?page=1&items_per_page=5');
  if (convs) {
    console.log(`\nTotal conversations: ${convs.meta?.total_count ?? 'unknown'}`);
    console.log('Sample fields:', Object.keys(convs.conversations?.[0] ?? {}).join(', '));
  }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
