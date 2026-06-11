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

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const groups = await fdGet('groups');
  const cssGroupIds = new Set(
    groups.filter(g => ['General', 'Campaigns'].includes(g.name)).map(g => g.id)
  );
  console.log('CSS group IDs:', [...cssGroupIds]);

  // Count ALL tickets created in June 2026 (no group filter) to verify total
  console.log('\n=== Counting ALL tickets created in June 2026 ===');
  let allTotal = 0, cssTotal = 0;
  const jun2026Start = '2026-06-01T00:00:00Z';

  for (let page = 1; page <= 50; page++) {
    const batch = await fdGet('tickets', {
      per_page: 100, page,
      order_by: 'created_at', order_type: 'asc',
      created_since: jun2026Start,
    });
    if (!Array.isArray(batch) || batch.length === 0) break;

    const junBatch = batch.filter(t => t.created_at?.startsWith('2026-06'));
    allTotal += junBatch.length;
    cssTotal += junBatch.filter(t => cssGroupIds.has(t.group_id)).length;

    console.log(`  page ${page}: ${junBatch.length} June tickets (${junBatch.filter(t => cssGroupIds.has(t.group_id)).length} CSS) — running total: all=${allTotal} css=${cssTotal}`);

    if (batch.length < 100) break;
    await sleep(400);
  }

  console.log(`\nFinal: ${allTotal} total June 2026 tickets, ${cssTotal} CSS (General+Campaigns)`);
  console.log('Expected from Freshdesk Analytics: 1818');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
