// TEMP (read-only) — classify a BATCH of months of CSS tickets into personas.
// MONTHS env = comma-separated "YYYY-MM" list. Runs in parallel batches so the
// full year finishes fast. Prints JSON for that batch; caller merges batches.
const FD_KEY = process.env.FRESHDESK_KEY;
const FD_DOMAIN = process.env.FRESHDESK_DOMAIN || 'universaltennis';
const MONTHS = (process.env.MONTHS || '').split(',').map(s => s.trim()).filter(Boolean);
const fdAuth = () => 'Basic ' + Buffer.from(`${FD_KEY}:X`).toString('base64');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SLEEP = 3000; // keep the 3s Freshdesk throttle (parallelism gives the speedup, not a tighter rate)
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
  throw new Error('search failed after retries');
}
async function searchRange(gid, start, end, out, depth = 0) {
  const s = start.toISOString().slice(0, 10), e = end.toISOString().slice(0, 10);
  if (s === e) return;
  const q = `group_id:${gid} AND created_at:>'${s}' AND created_at:<'${e}'`;
  const first = await fdSearch(q, 1); await sleep(SLEEP);
  const total = first?.total ?? 0;
  if (total > 300 && depth < 9) {
    const mid = new Date((start.getTime() + end.getTime()) / 2);
    await searchRange(gid, start, mid, out, depth + 1);
    await searchRange(gid, mid, end, out, depth + 1);
    return;
  }
  for (const t of (first?.results ?? [])) out.set(t.id, t);
  const pages = Math.min(10, Math.ceil(total / 30));
  for (let p = 2; p <= pages; p++) { const r = await fdSearch(q, p); for (const t of (r?.results ?? [])) out.set(t.id, t); await sleep(SLEEP); }
}

const PARENT_RE = /\b(my (son|daughter|child|kid)|our (son|daughter|child)|as a parent|my player)\b/i;
function classify(t) {
  const type = t.type || '';
  const cf = t.custom_fields ?? {};
  const role = (cf.cf_are_you_a_player_parent_coach_or_organizer ?? cf.cf_player_coach_parent ?? '').toLowerCase();
  const sub = (cf.cf_subscription_status || '').toLowerCase();
  const text = `${t.subject || ''} ${cf.cf_whats_going_on || ''}`;
  if (type === 'High School') return 'High school';
  if (type === 'College') return 'College';
  if (role.includes('organizer') || role.includes('provider') || type === 'I want to bring UTR Sports to my club!' || cf.cf_club) return 'Club customers';
  if (role.includes('parent') || PARENT_RE.test(text)) return 'Parents';
  if (sub === 'power') return 'Power subscribers';
  return 'Free users';
}

(async () => {
  if (!MONTHS.length) throw new Error('MONTHS env empty');
  const groups = await fdGet('groups'); await sleep(SLEEP);
  const cssIds = groups.filter(g => CSS_GROUP_NAMES.includes(g.name)).map(g => g.id);
  console.log(`BATCH months=${MONTHS.join(',')}  cssGroups=${cssIds.join(',')}`);
  const byId = new Map();
  for (const mk of MONTHS) {
    const [y, m] = mk.split('-').map(Number);
    const start = new Date(Date.UTC(y, m - 1, 1));
    const end = new Date(Date.UTC(y, m, 1));
    for (const gid of cssIds) await searchRange(gid, start, end, byId);
    console.log(`  ${mk} done — cumulative unique this batch: ${byId.size}`);
  }
  const personas = ['High school','College','Club customers','Parents','Power subscribers','Free users'];
  const total = {}, byMonth = {}, monthTotal = {}, typeByMonth = {};
  for (const p of personas) { total[p] = 0; byMonth[p] = {}; }
  for (const t of byId.values()) {
    const mk = (t.created_at || '').slice(0, 7); if (!MONTHS.includes(mk)) continue; // guard boundary bleed
    const p = classify(t);
    total[p]++; byMonth[p][mk] = (byMonth[p][mk] || 0) + 1;
    monthTotal[mk] = (monthTotal[mk] || 0) + 1;
    const ty = t.type || 'null'; (typeByMonth[ty] ??= {}); typeByMonth[ty][mk] = (typeByMonth[ty][mk] || 0) + 1;
  }
  console.log('\n===RESULT_JSON===');
  console.log(JSON.stringify({ months: MONTHS, total, byMonth, monthTotal, typeByMonth }));
  console.log('===END_RESULT===');
})();