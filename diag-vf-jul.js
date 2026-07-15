// TEMP (read-only) — current VF scoring state for July 2026.
const VF_KEY = process.env.VOICEFLOW_KEY;
const VF_PROJECT = '69ebd4159a532921bd258f8d';
const VF_ANALYTICS = 'https://analytics-api.voiceflow.com';
const vfHeaders = () => ({ authorization: VF_KEY, 'content-type': 'application/json', accept: 'application/json' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isBounce = s => !(s.logs ?? []).some(l => l.type === 'action' && l.data?.type === 'text');
function deflection(s) {
  const ev = (s.evaluations ?? []).find(e => /deflection rate \(strict\)/i.test(e?.name ?? ''));
  if (!ev) return null;
  const v = String(ev.value ?? '').trim().toLowerCase();
  return (v === 'pass' || v === 'fail') ? v : (v === 'na' || v === 'n/a') ? 'na' : null;
}
async function windows(start, end) {
  const byId = new Map(); let cur = end.getTime(); const s = start.getTime();
  while (cur > s) {
    const ws = new Date(Math.max(cur - 7*86400000 + 1, s));
    const r = await fetch(`${VF_ANALYTICS}/v1/transcript/project/${VF_PROJECT}`, { method:'POST', headers:vfHeaders(),
      body: JSON.stringify({ startDate: ws.toISOString(), endDate: new Date(cur).toISOString() }) });
    const list = r.ok ? ((await r.json())?.transcripts ?? []) : [];
    for (const t of list) if (t?.id) byId.set(t.id, t);
    cur = ws.getTime() - 1; await sleep(200);
  }
  return [...byId.values()];
}
(async () => {
  if (!VF_KEY) throw new Error('no key');
  const all = await windows(new Date('2026-07-01T00:00:00Z'), new Date());
  for (let i=0;i<all.length;i+=10){ await Promise.all(all.slice(i,i+10).map(async t=>{
    try{const r=await fetch(`${VF_ANALYTICS}/v1/transcript/${t.id}`,{headers:vfHeaders()}); if(r.ok){const b=await r.json(); t.logs=b.logs??b.transcript?.logs??[]; t.evaluations=b.evaluations??b.transcript?.evaluations??[]; t.createdAt=t.createdAt??b.createdAt;}else t.logs=[];}catch{t.logs=[];}
  })); await sleep(150);}
  const july = all.filter(t => (t.createdAt??'').slice(0,7)==='2026-07');
  const engaged = july.filter(s=>!isBounce(s));
  const dist={pass:0,fail:0,na:0,none:0};
  for (const s of engaged){ dist[deflection(s)??'none']++; }
  const den=dist.pass+dist.fail;
  console.log(`July transcripts: ${july.length}  engaged: ${engaged.length}`);
  console.log(`deflection: pass=${dist.pass} fail=${dist.fail} na=${dist.na} UNSCORED=${dist.none}`);
  console.log(`scored (pass+fail+na): ${dist.pass+dist.fail+dist.na} of ${engaged.length} engaged`);
  console.log(`AI Resolution % = pass/(pass+fail) = ${den?(100*dist.pass/den).toFixed(1)+'%':'N/A'} (den ${den})`);
})();
