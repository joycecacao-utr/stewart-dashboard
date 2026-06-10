// Quick diagnostic: find tickets with no group or unknown groups in the last 90 days
const DOMAIN = process.env.FRESHDESK_DOMAIN || 'universaltennis';
const KEY    = process.env.FRESHDESK_KEY;
const base64 = Buffer.from(`${KEY}:X`).toString('base64');

const since = new Date(Date.now() - 90 * 86400000).toISOString();

async function fdGet(path, params = {}) {
  const url = new URL(`https://${DOMAIN}.freshdesk.com/api/v2/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { Authorization: `Basic ${base64}` } });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} — ${path}`);
  return r.json();
}

async function main() {
  // Fetch all groups for reference
  const groups = await fdGet('groups');
  const groupMap = Object.fromEntries(groups.map(g => [g.id, g.name]));
  console.log('\nAll groups:', groups.map(g => `"${g.name}" (${g.id})`).join(', '));

  // Fetch recent tickets (no group filter) — just page 1 to sample
  console.log(`\nFetching tickets updated since ${since.slice(0,10)} (page 1, no group filter)…`);
  const tickets = await fdGet('tickets', {
    updated_since: since, per_page: 100, page: 1,
    order_by: 'updated_at', order_type: 'desc',
  });

  // Tally by group
  const tally = {};
  for (const t of tickets) {
    const name = t.group_id ? (groupMap[t.group_id] ?? `Unknown(${t.group_id})`) : 'NO GROUP';
    tally[name] = (tally[name] ?? 0) + 1;
  }

  console.log('\nTicket count by group (last 90d, page 1 only):');
  for (const [name, count] of Object.entries(tally).sort((a,b) => b[1]-a[1]))
    console.log(`  ${count.toString().padStart(4)}  ${name}`);

  // Also check unassigned specifically across more pages
  console.log('\nChecking for tickets with NO group (pages 1-3):');
  let noGroup = [];
  for (let page = 1; page <= 3; page++) {
    const batch = await fdGet('tickets', {
      updated_since: since, per_page: 100, page,
      order_by: 'updated_at', order_type: 'desc',
    });
    noGroup.push(...batch.filter(t => !t.group_id));
    if (batch.length < 100) break;
  }
  console.log(`  Found ${noGroup.length} unassigned tickets`);
  noGroup.slice(0, 5).forEach(t =>
    console.log(`  id=${t.id} subject="${t.subject?.slice(0,60)}" created=${t.created_at?.slice(0,10)}`)
  );
}

main().catch(console.error);
