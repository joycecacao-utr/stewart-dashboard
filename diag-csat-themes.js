// TEMP (read-only) — pull recent positive CSAT comments and group by theme,
// so we can diversify Happy Thoughts beyond "fast response".
const FD_KEY = process.env.FRESHDESK_KEY;
const FD_DOMAIN = process.env.FRESHDESK_DOMAIN || 'universaltennis';
const fdAuth = () => 'Basic ' + Buffer.from(`${FD_KEY}:X`).toString('base64');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SLEEP = 2500;

async function fdGetAll(path, params) {
  const out = []; let page = 1;
  while (page <= 25) {
    const url = new URL(`https://${FD_DOMAIN}.freshdesk.com/api/v2/${path}`);
    for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
    url.searchParams.set('per_page', '100'); url.searchParams.set('page', String(page));
    let r;
    for (let a = 0; a < 8; a++) {
      r = await fetch(url, { headers: { Authorization: fdAuth() } });
      if (r.status === 429) { await sleep((+(r.headers.get('retry-after') || 30) + 3) * 1000); continue; }
      break;
    }
    if (!r.ok) { console.log(`  ${path} p${page} HTTP ${r.status}`); break; }
    const arr = await r.json();
    out.push(...arr);
    if (arr.length < 100) break;
    page++; await sleep(SLEEP);
  }
  return out;
}

const THEMES = {
  'speed':        /\b(fast|quick|prompt|speedy|immediate|right away|instant|timely|responsive)\b/i,
  'friendly':    /\b(kind|friendly|polite|nice|patient|courteous|pleasant|caring|warm)\b/i,
  'resolved':    /\b(resolv|solved|fixed|sorted|taken care|handled|took care)\b/i,
  'helpful':     /\b(helpful|help|assist|guidance|guided|walked me|explained|clear)\b/i,
  'thorough':    /\b(thorough|detailed|professional|knowledge|competent|efficient)\b/i,
  'grateful':    /\b(thank|appreciate|grateful|great|excellent|amazing|wonderful|awesome|perfect)\b/i,
};

(async () => {
  const since = new Date(Date.now() - 120 * 86400000).toISOString();
  let csat = await fdGetAll('surveys/satisfaction_ratings', { created_since: since });
  if (!csat.length) csat = await fdGetAll('satisfaction_ratings', { created_since: since });
  console.log(`Pulled ${csat.length} ratings since ${since.slice(0,10)}`);

  const positive = csat.filter(r => {
    const v = r.ratings?.default_question ?? r.ratings?.overall;
    const isTop = v === 1 || v === 5 || v === 103 || v === 3;
    const c = (r.feedback ?? r.remarks ?? '');
    return isTop && typeof c === 'string' && c.trim().length > 15;
  });
  console.log(`Positive w/ comment (>15 chars): ${positive.length}\n`);

  // Theme tally + sample comments per theme
  const byTheme = {}; Object.keys(THEMES).forEach(t => byTheme[t] = []);
  const seen = new Set();
  for (const r of positive.sort((a,b)=>new Date(b.created_at)-new Date(a.created_at))) {
    const c = (r.feedback ?? r.remarks ?? '').trim().replace(/\s+/g,' ');
    const key = c.slice(0,45).toLowerCase(); if (seen.has(key)) continue; seen.add(key);
    for (const [t, re] of Object.entries(THEMES)) if (re.test(c)) byTheme[t].push(c.slice(0,140));
  }
  console.log('=== THEME TALLY (deduped positive comments) ===');
  for (const t of Object.keys(THEMES)) console.log(`  ${t}: ${byTheme[t].length}`);
  console.log('\n=== SAMPLE COMMENTS BY THEME ===');
  for (const t of Object.keys(THEMES)) {
    console.log(`\n--- ${t} ---`);
    for (const c of byTheme[t].slice(0, 12)) console.log(`   "${c}"`);
  }
})();
