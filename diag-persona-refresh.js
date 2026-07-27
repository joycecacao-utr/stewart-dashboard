// TEMP (read-only) — refresh persona volumes (12-mo role segments; Free/Power recent)
// + collect recent ticket subjects per persona to inform the concern bullets.
// Per month: 1 count query for the true total + a capped sample classified with the
// EXACT approved cascade; scale sample proportions to the real total. Bounded calls.
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
  for (let a = 0; a < 8; a++) {
    const r = await fetch(url, { headers: { Authorization: fdAuth() } });
    if (r.status === 429) { await sleep((+(r.headers.get('retry-after') || 30) + 3) * 1000); continue; }
    if (!r.ok) { await sleep(2000); continue; }
    return r.json();
  }
  return { total: -1, results: [] };
}

const ROLE_RE = /provider|organizer|coach|parent|player|\bmine\b|child/i;
function roleVals(t) {
  const out = [];
  for (const v of Object.values(t.custom_fields ?? {})) if (typeof v === 'string' && ROLE_RE.test(v)) out.push(v.toLowerCase());
  return out;
}
function classify(t) {
  const type = t.type || '';
  const vals = roleVals(t);
  const has = re => vals.some(v => re.test(v));
  const isCollege = type === 'College', isHS = type === 'High School';
  const sub = (t.custom_fields?.cf_subscription_status || '').toLowerCase();
  const bySub = () => sub === 'power' ? 'Power subscribers' : 'Free users';
  if (vals.length) {
    if (has(/provider|organizer/)) return 'Club customers';
    if (has(/coach/)) return isCollege ? 'College' : isHS ? 'High school' : 'Club customers';
    if (has(/parent|one of my child|children/)) return 'Parents';
    if (has(/one of my player/)) return isCollege ? 'College' : isHS ? 'High school' : 'Club customers';
    if (has(/player|\bmine\b/)) return isCollege ? 'College' : isHS ? 'High school' : bySub();
    return sub ? bySub() : 'EXCLUDE';
  }
  return sub ? bySub() : 'EXCLUDE';
}

function monthKeys(n) {
  const out = []; const base = new Date(Date.UTC(2026, 6, 1)); // anchor Jul 2026
  for (let i = n - 1; i >= 0; i--) { const d = new Date(base); d.setUTCMonth(d.getUTCMonth() - i); out.push(d.toISOString().slice(0, 7)); }
  return out;
}

(async () => {
  const groups = await fdGet('groups'); await sleep(SLEEP);
  const cssIds = groups.filter(g => CSS_GROUP_NAMES.includes(g.name)).map(g => g.id);
  const grp = '(' + cssIds.map(id => `group_id:${id}`).join(' OR ') + ')';
  const personas = ['Club customers','Power subscribers','College','High school','Parents','Free users'];
  const months = monthKeys(13);
  const perMonth = {};
  const subjectsByPersona = {}; personas.forEach(p => subjectsByPersona[p] = []);
  const recentMonths = new Set(months.slice(-3)); // last 3 months for subject/theme review

  for (const mk of months) {
    const [y, m] = mk.split('-').map(Number);
    const s = new Date(Date.UTC(y, m - 1, 1)), e = new Date(Date.UTC(y, m, 1));
    const clause = `created_at:>'${new Date(s - 86400000).toISOString().slice(0,10)}' AND created_at:<'${e.toISOString().slice(0,10)}'`;
    const q = `${grp} AND ${clause}`;
    const first = await fdSearch(q, 1); await sleep(SLEEP);
    const total = first.total ?? 0;
    const sample = [...(first.results ?? [])];
    for (let p = 2; p <= 10; p++) { const r = await fdSearch(q, p); const arr = r.results ?? []; sample.push(...arr); if (arr.length < 30) break; await sleep(SLEEP); }
    const cnt = {}; let excl = 0; const types = {};
    for (const t of sample) {
      const p = classify(t); if (p === 'EXCLUDE') excl++; else cnt[p] = (cnt[p] || 0) + 1;
      const ty = t.type || 'null'; types[ty] = (types[ty] || 0) + 1;
      if (p !== 'EXCLUDE' && recentMonths.has(mk) && t.subject) subjectsByPersona[p].push(`[${mk}|${ty}] ${String(t.subject).slice(0,90)}`);
    }
    const classifiableSample = sample.length - excl;
    const classifiableTotal = sample.length ? Math.round(total * classifiableSample / sample.length) : 0;
    const scaled = {};
    for (const p of personas) scaled[p] = classifiableSample ? Math.round((cnt[p] || 0) / classifiableSample * classifiableTotal) : 0;
    perMonth[mk] = { total, sampleSize: sample.length, excludedPctSample: sample.length ? +(100*excl/sample.length).toFixed(1) : 0, classifiableTotalEst: classifiableTotal, scaled };
    console.log(`${mk}: total=${total} sample=${sample.length} excl%=${perMonth[mk].excludedPctSample} classifiableEst=${classifiableTotal}`);
  }

  // Role segments: sum over 12 months (exclude the 13th oldest to make it a clean trailing-12). Free/Power: recent months only.
  const trailing12 = months.slice(1); // 12 months ending Jul 2026
  const roleSegs = ['Club customers','College','High school','Parents'];
  const subSegs  = ['Power subscribers','Free users'];
  const recentForSub = months.slice(-2); // Jun + Jul 2026 (subscription tracking began ~Jun)
  const vol = {};
  for (const p of roleSegs) vol[p] = trailing12.reduce((a,mk)=>a+(perMonth[mk].scaled[p]||0),0);
  for (const p of subSegs)  vol[p] = recentForSub.reduce((a,mk)=>a+(perMonth[mk].scaled[p]||0),0);

  console.log('\n===PERSONA VOLUME===');
  for (const p of roleSegs) console.log(`  ${p}: ~${vol[p]} (trailing 12 mo)`);
  for (const p of subSegs)  console.log(`  ${p}: ~${vol[p]} (${recentForSub.join('+')})`);

  console.log('\n===RECENT SUBJECTS BY PERSONA (last 3 mo sample)===');
  for (const p of personas) {
    console.log(`\n--- ${p} (${subjectsByPersona[p].length} sampled) ---`);
    for (const s of subjectsByPersona[p].slice(0, 25)) console.log(`   ${s}`);
  }
  console.log('\n===RESULT_JSON===');
  console.log(JSON.stringify({ months, vol, perMonth }));
  console.log('===END===');
})();
