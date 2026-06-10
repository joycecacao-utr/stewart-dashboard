const DOMAIN = process.env.FRESHDESK_DOMAIN || 'universaltennis';
const KEY    = process.env.FRESHDESK_KEY;
const base64 = Buffer.from(`${KEY}:X`).toString('base64');

async function fdGet(path, params = {}) {
  const url = new URL(`https://${DOMAIN}.freshdesk.com/api/v2/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { Authorization: `Basic ${base64}` } });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} — ${path}`);
  return r.json();
}

async function main() {
  // ── Step 1: 10 most recently CREATED tickets, no filters ──────────────────
  console.log('\n=== STEP 1: 10 most recently created tickets (no filter) ===');
  const groups = await fdGet('groups');
  const groupMap = Object.fromEntries(groups.map(g => [g.id, g.name]));

  const recent = await fdGet('tickets', {
    per_page: 10, page: 1,
    order_by: 'created_at', order_type: 'desc',
  });
  recent.forEach(t => {
    const gName = t.group_id ? (groupMap[t.group_id] ?? `Unknown(${t.group_id})`) : 'NO GROUP';
    console.log(`  id=${t.id}  created=${t.created_at?.slice(0,10)}  group="${gName}"  tags=[${(t.tags??[]).join(',')}]  type=${t.type??'null'}`);
  });

  // ── Step 2: Current CSS filter ────────────────────────────────────────────
  console.log('\n=== STEP 2: Current CSS filter in fetch-css-data.js ===');
  console.log('  CSS_GROUP_NAMES = ["General", "Campaigns"]');
  console.log('  Match logic: ticket is included if its group_id is in the set of IDs');
  console.log('  matching those group names.');
  const cssGroups = groups.filter(g => ['General', 'Campaigns'].includes(g.name));
  const cssGroupIds = new Set(cssGroups.map(g => g.id));
  console.log('  Matched group IDs:', [...cssGroupIds]);
  cssGroups.forEach(g => console.log(`    "${g.name}" → id=${g.id}`));

  // ── Step 3: Same 10 most recent, CSS filter applied ───────────────────────
  console.log('\n=== STEP 3: Most recent tickets matching CSS filter ===');
  // Scan pages 1-5 (500 tickets) to find latest CSS ones
  const cssTickets = [];
  for (let page = 1; page <= 5 && cssTickets.length < 10; page++) {
    const batch = await fdGet('tickets', {
      per_page: 100, page,
      order_by: 'created_at', order_type: 'desc',
    });
    if (!batch.length) break;
    for (const t of batch) {
      if (cssGroupIds.has(t.group_id)) cssTickets.push(t);
    }
  }
  console.log(`  Found ${cssTickets.length} CSS tickets in top 500 by created_at desc:`);
  cssTickets.slice(0, 10).forEach(t => {
    const gName = groupMap[t.group_id] ?? `Unknown(${t.group_id})`;
    console.log(`  id=${t.id}  created=${t.created_at?.slice(0,10)}  group="${gName}"  tags=[${(t.tags??[]).join(',')}]`);
  });

  // ── Bonus: tally groups across top 200 most recent tickets ────────────────
  console.log('\n=== BONUS: Group breakdown of 200 most recently created tickets ===');
  const tally = {};
  for (let page = 1; page <= 2; page++) {
    const batch = await fdGet('tickets', {
      per_page: 100, page,
      order_by: 'created_at', order_type: 'desc',
    });
    for (const t of batch) {
      const name = t.group_id ? (groupMap[t.group_id] ?? `Unknown(${t.group_id})`) : 'NO GROUP';
      tally[name] = (tally[name] ?? 0) + 1;
    }
  }
  for (const [name, count] of Object.entries(tally).sort((a,b) => b[1]-a[1]))
    console.log(`  ${count.toString().padStart(4)}  ${name}`);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
