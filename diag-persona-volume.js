// TEMP (read-only) — persona volume via COUNT queries (no ticket pagination).
// Asks Freshdesk search for the TOTAL per persona criterion for MONTHS (YYYY-MM list).
const FD_KEY = process.env.FRESHDESK_KEY;
const FD_DOMAIN = process.env.FRESHDESK_DOMAIN || 'universaltennis';
const MONTHS = (process.env.MONTHS || '').split(',').map(s => s.trim()).filter(Boolean);
const fdAuth = () => 'Basic ' + Buffer.from(`${FD_KEY}:X`).toString('base64');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SLEEP = 3000;
const CSS_GROUP_NAMES = ['General', 'Campaigns', 'Bug Captain'];

async function fdGet(path) {
  const r = await fetch(`https://${FD_DOMAIN}.freshdesk.com/api/v2/${path}`, { headers: { Authorization: fdAuth() } });
  if (!r.ok) throw new Error(`${path} HTTP ${r.status}`);
  return r.json();
}
// Return total count for a query (page 1 carries `total`).
async function count(query) {
  const url = new URL(`https://${FD_DOMAIN}.freshdesk.com/api/v2/search/tickets`);
  url.searchParams.set('query', `"${query}"`); url.searchParams.set('page', 1);
  for (let a = 0; a < 8; a++) {
    const r = await fetch(url, { headers: { Authorization: fdAuth() } });
    if (r.status === 429) { const w = (+(r.headers.get('retry-after') || 30) + 3) * 1000; console.log(`  429, wait ${w/1000}s`); await sleep(w); continue; }
    if (!r.ok) { await sleep(2000); continue; }
    const b = await r.json(); return b?.total ?? 0;
  }
  return -1;
}

(async () => {
  if (!MONTHS.length) throw new Error('MONTHS env empty');
  const groups = await fdGet('groups'); await sleep(SLEEP);
  const cssIds = groups.filter(g => CSS_GROUP_NAMES.includes(g.name)).map(g => g.id);
  const grp = '(' + cssIds.map(id => `group_id:${id}`).join(' OR ') + ')';

  // window covering the month(s): from day before first month start to first day after last month end
  const first = MONTHS[0].split('-').map(Number);
  const last = MONTHS[MONTHS.length - 1].split('-').map(Number);
  const startD = new Date(Date.UTC(first[0], first[1] - 1, 1));
  const endD = new Date(Date.UTC(last[0], last[1], 1));
  const dateClause = `created_at:>'${new Date(startD - 86400000).toISOString().slice(0,10)}' AND created_at:<'${endD.toISOString().slice(0,10)}'`;
  const base = `${grp} AND ${dateClause}`;
  console.log(`window: ${MONTHS.join(',')}  css groups: ${cssIds.join(',')}`);

  const q = {};
  q.total    = base;
  q.HS       = `${base} AND type:'High School'`;
  q.College  = `${base} AND type:'College'`;
  q.ClubType = `${base} AND type:'I want to bring UTR Sports to my club!'`;
  q.Organizer= `${base} AND cf_are_you_a_player_parent_coach_or_organizer:'Organizer'`;
  q.Provider = `${base} AND cf_are_you_a_player_parent_coach_or_organizer:'Provider'`;
  q.Parent   = `${base} AND cf_are_you_a_player_parent_coach_or_organizer:'Parent'`;
  q.Power    = `${base} AND cf_subscription_status:'Power'`;
  q.Free     = `${base} AND cf_subscription_status:'Free'`;

  const res = {};
  for (const [k, query] of Object.entries(q)) { res[k] = await count(query); console.log(`  ${k}: ${res[k]}`); await sleep(SLEEP); }

  const HS = res.HS, College = res.College;
  const Club = res.ClubType + res.Organizer + res.Provider;
  const Parents = res.Parent;
  const Power = res.Power;
  const classifiedNonFree = HS + College + Club + Parents + Power;
  const FreeUsers = Math.max(0, res.total - classifiedNonFree); // remainder = individual players (incl. Free-sub)
  const pct = n => res.total ? (100 * n / res.total).toFixed(1) + '%' : 'n/a';

  console.log('\n===RESULT===');
  console.log(`Total CSS tickets (${MONTHS.join(',')}): ${res.total}`);
  const out = { 'High school': HS, 'College': College, 'Club customers': Club, 'Parents': Parents, 'Power subscribers': Power, 'Free users': FreeUsers };
  for (const [p, n] of Object.entries(out)) console.log(`  ${p}: ${n} (${pct(n)} of CSS volume)`);
  console.log('\nraw counts:', JSON.stringify(res));
  console.log('note: Free-sub tag alone =', res.Free, '(subscription field only ~34% populated; Free users shown as the remainder)');
  console.log('===END===');
})();
