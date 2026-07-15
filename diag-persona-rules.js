// TEMP (read-only) — apply the rule-based persona cascade to a June sample AND
// dump sub-property fields/values by ticket type so we can confirm the mapping.
const FD_KEY = process.env.FRESHDESK_KEY;
const FD_DOMAIN = process.env.FRESHDESK_DOMAIN || 'universaltennis';
const fdAuth = () => 'Basic ' + Buffer.from(`${FD_KEY}:X`).toString('base64');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SLEEP = 3000;
const CSS_GROUP_NAMES = ['General', 'Campaigns', 'Bug Captain'];

async function fdGet(path) {
  const r = await fetch(`https://${FD_DOMAIN}.freshdesk.com/api/v2/${path}`, { headers: { Authorization: fdAuth() } });
  if (!r.ok) throw new Error(`${path} HTTP ${r.status}`);
  return r.json();
}
async function fdSearch(query, page) {
  const url = new URL(`https://${FD_DOMAIN}.freshdesk.com/api/v2/search/tickets`);
  url.searchParams.set('query', `"${query}"`); url.searchParams.set('page', page);
  for (let a = 0; a < 6; a++) {
    const r = await fetch(url, { headers: { Authorization: fdAuth() } });
    if (r.status === 429) { const w = (+(r.headers.get('retry-after') || 30) + 3) * 1000; await sleep(w); continue; }
    if (!r.ok) { await sleep(2000); continue; }
    return r.json();
  }
  throw new Error('search failed');
}

const ROLE_RE = /provider|organizer|coach|parent|player|\bmine\b|child/i;
// Collect role-ish sub-property values from a ticket's custom fields (any cf key).
function roleValues(t) {
  const out = [];
  for (const [k, v] of Object.entries(t.custom_fields ?? {})) {
    if (typeof v === 'string' && ROLE_RE.test(v)) out.push([k, v]);
  }
  return out;
}
function subOf(t) { return (t.custom_fields?.cf_subscription_status || '').toLowerCase(); }

// Rule cascade → persona name, or null (EXCLUDE).
function classify(t) {
  const type = t.type || '';
  const vals = roleValues(t).map(([, v]) => v.toLowerCase());
  const has = re => vals.some(v => re.test(v));
  const isCollege = type === 'College', isHS = type === 'High School';
  const sub = subOf(t);
  const bySub = () => sub === 'power' ? 'Power subscribers' : sub === 'free' ? 'Free users' : null;

  if (vals.length) { // has a persona sub-property
    if (has(/provider|organizer/)) return 'Club customers';
    if (has(/coach/)) return isCollege ? 'College' : isHS ? 'High school' : 'Club customers';
    if (has(/parent|one of my child|my child|children/)) return 'Parents';
    if (has(/one of my player/)) return isCollege ? 'College' : isHS ? 'High school' : 'Club customers';
    if (has(/player|\bmine\b/)) return isCollege ? 'College' : isHS ? 'High school' : (bySub() || 'EXCLUDE_player_nosub');
    return bySub() || 'EXCLUDE_role_unmapped';
  }
  // no sub-property → subscription fallback → else exclude
  return bySub() || 'EXCLUDE_no_signal';
}

(async () => {
  const groups = await fdGet('groups'); await sleep(SLEEP);
  const cssIds = groups.filter(g => CSS_GROUP_NAMES.includes(g.name)).map(g => g.id);
  const tickets = [];
  for (const gid of cssIds) {
    const q = `group_id:${gid} AND created_at:>'2026-05-31' AND created_at:<'2026-07-01'`;
    for (let p = 1; p <= 10; p++) { const r = await fdSearch(q, p); const arr = r?.results ?? []; tickets.push(...arr); if (arr.length < 30) break; await sleep(SLEEP); }
  }
  console.log(`June sample: ${tickets.length} CSS tickets (search-capped)\n`);

  // A) sub-property field discovery, by ticket type
  const typeCount = {}, subPropByType = {};
  for (const t of tickets) {
    const ty = t.type || 'null'; typeCount[ty] = (typeCount[ty] || 0) + 1;
    for (const [k, v] of roleValues(t)) {
      subPropByType[ty] ??= {}; subPropByType[ty][`${k}=${v}`] = (subPropByType[ty][`${k}=${v}`] || 0) + 1;
    }
  }
  console.log('=== ticket types in sample ==='); console.log(JSON.stringify(typeCount, null, 0));
  console.log('\n=== sub-property values seen, by ticket type (key=value -> count) ===');
  for (const [ty, m] of Object.entries(subPropByType)) console.log(`  ${ty}: ${JSON.stringify(m)}`);

  // B) apply cascade
  const counts = {};
  for (const t of tickets) { const p = classify(t); counts[p] = (counts[p] || 0) + 1; }
  const personas = ['Club customers','Power subscribers','College','High school','Parents','Free users'];
  const excludedKeys = Object.keys(counts).filter(k => k.startsWith('EXCLUDE'));
  const excluded = excludedKeys.reduce((s, k) => s + counts[k], 0);
  const classifiable = tickets.length - excluded;
  const pct = n => classifiable ? (100 * n / classifiable).toFixed(1) + '%' : 'n/a';
  console.log('\n=== PERSONA COUNTS (of classifiable) ===');
  for (const p of personas) console.log(`  ${p}: ${counts[p] || 0} (${pct(counts[p] || 0)})`);
  console.log(`\nEXCLUDED: ${excluded} of ${tickets.length} (${(100*excluded/tickets.length).toFixed(1)}% of total) — breakdown: ${JSON.stringify(Object.fromEntries(excludedKeys.map(k=>[k,counts[k]])))}`);
  console.log(`Classifiable total: ${classifiable} (${(100*classifiable/tickets.length).toFixed(1)}% of tickets have an identifiable segment)`);
})();
