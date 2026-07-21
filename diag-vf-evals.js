// TEMP (read-only) — dump the ACTUAL values of every Voiceflow evaluation for
// June & July, so we can see which metric = the boss's "AI Resolution ~12%".
const VF_KEY = process.env.VOICEFLOW_KEY;
const VF_PROJECT = '69ebd4159a532921bd258f8d';
const VF_ANALYTICS = 'https://analytics-api.voiceflow.com';
const vfHeaders = () => ({ authorization: VF_KEY, 'content-type': 'application/json', accept: 'application/json' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function listWindows(start, end) {
  const byId = new Map(); let cur = end.getTime(); const s = start.getTime();
  while (cur > s) {
    const ws = new Date(Math.max(cur - 7*86400000 + 1, s));
    const r = await fetch(`${VF_ANALYTICS}/v1/transcript/project/${VF_PROJECT}`, { method:'POST', headers:vfHeaders(),
      body: JSON.stringify({ startDate: ws.toISOString(), endDate: new Date(cur).toISOString() }) });
    const list = r.ok ? ((await r.json())?.transcripts ?? []) : [];
    for (const t of list) if (t?.id) byId.set(t.id, t);
    cur = ws.getTime() - 1; await sleep(120);
  }
  return [...byId.values()];
}

(async () => {
  if (!VF_KEY) throw new Error('no key');
  const all = await listWindows(new Date(Date.now() - 70*86400000), new Date());
  for (let i=0;i<all.length;i+=10){ await Promise.all(all.slice(i,i+10).map(async t=>{
    try{const r=await fetch(`${VF_ANALYTICS}/v1/transcript/${t.id}`,{headers:vfHeaders()}); if(r.ok){const b=await r.json(); t.evaluations=b.evaluations??b.transcript?.evaluations??[]; t.createdAt=t.createdAt??b.createdAt;}else t.evaluations=[];}catch{t.evaluations=[];}
  })); await sleep(120);}

  // month -> evalName -> value -> count
  const agg = {};
  for (const t of all) {
    const mo = (t.createdAt ?? '').slice(0,7) || 'unknown';
    if (mo !== '2026-06' && mo !== '2026-07') continue;
    for (const e of (t.evaluations ?? [])) {
      const name = e?.name ?? '(unnamed)';
      let val = e?.value;
      if (val && typeof val === 'object') val = JSON.stringify(val).slice(0,60);
      val = String(val ?? 'null');
      agg[mo] = agg[mo] || {};
      agg[mo][name] = agg[mo][name] || {};
      agg[mo][name][val] = (agg[mo][name][val] || 0) + 1;
    }
  }
  console.log(`Total transcripts (70d): ${all.length}`);
  for (const mo of ['2026-06','2026-07']) {
    console.log(`\n======== ${mo} ========`);
    for (const [name, vals] of Object.entries(agg[mo] ?? {})) {
      const total = Object.values(vals).reduce((a,b)=>a+b,0);
      const parts = Object.entries(vals).sort((a,b)=>b[1]-a[1]).map(([v,c])=>`${v}=${c}`).join('  ');
      console.log(`  "${name}" (n=${total}): ${parts}`);
    }
  }
})();
