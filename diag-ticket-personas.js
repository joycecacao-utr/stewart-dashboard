// TEMP DIAGNOSTIC (read-only) — can CSS tickets be classified into the 6 personas,
// and how well are the classifying fields populated? Samples recent CSS tickets.
const FD_KEY = process.env.FRESHDESK_KEY;
const FD_DOMAIN = process.env.FRESHDESK_DOMAIN || 'universaltennis';
const fdAuth = () => 'Basic ' + Buffer.from(`${FD_KEY}:X`).toString('base64');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CSS_GROUP_NAMES = ['General', 'Campaigns', 'Bug Captain'];

async function fdGet(path, params = {}) {
  const url = new URL(`https://${FD_DOMAIN}.freshdesk.com/api/v2/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { Authorization: fdAuth() } });
  if (!r.ok) throw new Error(`${path} HTTP ${r.status}`);
  return r.json();
}
async function fdSearch(query, page) {
  const url = new URL(`https://${FD_DOMAIN}.freshdesk.com/api/v2/search/tickets`);
  url.searchParams.set('query', `"${query}"`);
  url.searchParams.set('page', page);
  const r = await fetch(url, { headers: { Authorization: fdAuth() } });
  if (r.status === 429) { await sleep(30000); return fdSearch(query, page); }
  if (!r.ok) throw new Error(`search HTTP ${r.status}`);
  return r.json();
}

(async () => {
  const groups = await fdGet('groups');
  const cssIds = groups.filter(g => CSS_GROUP_NAMES.includes(g.name)).map(g => g.id);
  console.log('CSS groups:', groups.filter(g=>CSS_GROUP_NAMES.includes(g.name)).map(g=>`${g.name}(${g.id})`).join(', '));

  // Sample: tickets created in the last 60 days per CSS group (search caps ~300/query).
  const since = '2026-05-09';
  const tickets = [];
  for (const gid of cssIds) {
    for (let page = 1; page <= 10; page++) {
      const q = `group_id:${gid} AND created_at:>'${since}'`;
      const res = await fdSearch(q, page);
      const arr = res?.results ?? [];
      tickets.push(...arr);
      if (arr.length < 30) break;
      await sleep(400);
    }
  }
  console.log(`sampled ${tickets.length} CSS tickets created since ${since}\n`);

  // Field population
  const fields = ['cf_subscription_status','cf_are_you_a_player_parent_coach_or_organizer','cf_player_coach_parent','cf_what_school','cf_high_school_drop_down','cf_club'];
  const pop = {}; for (const f of fields) pop[f] = 0;
  const subVals = {}, roleVals = {};
  for (const t of tickets) {
    const cf = t.custom_fields ?? {};
    for (const f of fields) if (cf[f] != null && cf[f] !== '') pop[f]++;
    const s = cf.cf_subscription_status; if (s) subVals[s] = (subVals[s]||0)+1;
    const r = cf.cf_are_you_a_player_parent_coach_or_organizer ?? cf.cf_player_coach_parent;
    if (r) roleVals[r] = (roleVals[r]||0)+1;
  }
  console.log('-- classifying-field population (% of sampled tickets) --');
  for (const f of fields) console.log(`  ${f}: ${pop[f]} (${(100*pop[f]/tickets.length).toFixed(0)}%)`);
  console.log('\n  cf_subscription_status values:', JSON.stringify(subVals));
  console.log('  role field values:', JSON.stringify(roleVals));

  // Attempt persona classification (note OVERLAP: tier vs role are independent)
  let tier=0, role=0, either=0, both=0, neither=0;
  const personaHits = {Free:0,Power:0,Parents:0,'Club/Coach/Organizer':0,'High school':0};
  for (const t of tickets) {
    const cf = t.custom_fields ?? {};
    const s = (cf.cf_subscription_status||'').toLowerCase();
    const roleRaw = (cf.cf_are_you_a_player_parent_coach_or_organizer ?? cf.cf_player_coach_parent ?? '').toLowerCase();
    const school = cf.cf_what_school || cf.cf_high_school_drop_down;
    const club = cf.cf_club;
    const hasTier = s==='free'||s==='power';
    const hasRole = !!roleRaw || !!school || !!club;
    if (s==='free') personaHits.Free++; if (s==='power') personaHits.Power++;
    if (roleRaw.includes('parent')) personaHits.Parents++;
    if (roleRaw.includes('coach')||roleRaw.includes('organizer')||club) personaHits['Club/Coach/Organizer']++;
    if (school) personaHits['High school']++;
    tier += hasTier?1:0; role += hasRole?1:0;
    either += (hasTier||hasRole)?1:0; both += (hasTier&&hasRole)?1:0; neither += (!hasTier&&!hasRole)?1:0;
  }
  const pct = n => (100*n/tickets.length).toFixed(0)+'%';
  console.log('\n-- classifiability --');
  console.log(`  has tier (Free/Power): ${tier} (${pct(tier)})`);
  console.log(`  has role/context signal: ${role} (${pct(role)})`);
  console.log(`  has EITHER: ${either} (${pct(either)})  | has BOTH (overlap): ${both}  | NEITHER (unclassifiable): ${neither} (${pct(neither)})`);
  console.log('\n-- per-persona raw hits (NOT mutually exclusive) --');
  console.log(JSON.stringify(personaHits, null, 1));
  console.log('\n-- College note: no dedicated ticket field; would rely on type/text --');
  const typeCounts = {};
  for (const t of tickets){ const ty=t.type??'null'; typeCounts[ty]=(typeCounts[ty]||0)+1; }
  console.log('ticket type distribution:', JSON.stringify(typeCounts, null, 1));
})();
