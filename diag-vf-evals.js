// TEMP (read-only) — enumerate ALL Voiceflow evaluation names + pass/fail/na counts
// per month, so we can see which evaluation actually carries July data.
const VF_KEY = process.env.VOICEFLOW_KEY;
const VF_PROJECT = '69ebd4159a532921bd258f8d';
const VF_ANALYTICS = 'https://analytics-api.voiceflow.com';
const vfHeaders = () => ({ authorization: VF_KEY, 'content-type': 'application/json', accept: 'application/json' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = v => String(v ?? '').trim().toLowerCase();

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
  const all = await listWindows(new Date(Date.now() - 95*86400000), new Date());
  for (let i=0;i<all.length;i+=10){ await Promise.all(all.slice(i,i+10).map(async t=>{
    try{const r=await fetch(`${VF_ANALYTICS}/v1/transcript/${t.id}`,{headers:vfHeaders()}); if(r.ok){const b=await r.json(); t.evaluations=b.evaluations??b.transcript?.evaluations??[]; t.createdAt=t.createdAt??b.createdAt;}else t.evaluations=[];}catch{t.evaluations=[];}
  })); await sleep(120);}

  // month -> evalName -> {pass,fail,na,other,total}
  const agg = {};
  for (const t of all) {
    const mo = (t.createdAt ?? '').slice(0,7) || 'unknown';
    for (const e of (t.evaluations ?? [])) {
      const name = e?.name ?? '(unnamed)';
      const v = norm(e?.value);
      agg[mo] = agg[mo] || {};
      agg[mo][name] = agg[mo][name] || { pass:0, fail:0, na:0, other:0, total:0 };
      const b = agg[mo][name];
      b.total++;
      if (v==='pass') b.pass++; else if (v==='fail') b.fail++;
      else if (v==='na'||v==='n/a') b.na++; else b.other++;
    }
  }
  console.log(`Total transcripts pulled (95d): ${all.length}`);
  for (const mo of Object.keys(agg).sort()) {
    console.log(`\n=== ${mo} ===`);
    for (const [name, b] of Object.entries(agg[mo])) {
      const den = b.pass + b.fail;
      const rate = den ? (100*b.pass/den).toFixed(1)+'%' : 'n/a';
      console.log(`  "${name}": pass=${b.pass} fail=${b.fail} na=${b.na} other=${b.other} total=${b.total} | pass/(pass+fail)=${rate}`);
    }
  }
})();
