// TEMP DIAGNOSTIC (read-only) — two things:
//  A) Inspect Freshdesk tickets for a subscription/plan field (for Free-user detection).
//  B) Pull real June chat language per persona, to ground updated persona quotes.
const FD_KEY  = process.env.FRESHDESK_KEY;
const VF_KEY  = process.env.VOICEFLOW_KEY;
const FD_DOMAIN = process.env.FRESHDESK_DOMAIN || 'universaltennis';
const VF_PROJECT = '69ebd4159a532921bd258f8d';
const VF_ANALYTICS = 'https://analytics-api.voiceflow.com';
const fdAuth = () => 'Basic ' + Buffer.from(`${FD_KEY}:X`).toString('base64');
const vfHeaders = () => ({ authorization: VF_KEY, 'content-type': 'application/json', accept: 'application/json' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- PART A: Freshdesk ticket fields ----------
async function inspectFreshdesk() {
  console.log('\n========== PART A: FRESHDESK TICKET FIELDS ==========');
  const r = await fetch(`https://${FD_DOMAIN}.freshdesk.com/api/v2/tickets?per_page=50&order_by=updated_at&order_type=desc`,
    { headers: { Authorization: fdAuth() } });
  if (!r.ok) { console.log('Freshdesk HTTP', r.status, await r.text()); return; }
  const tickets = await r.json();
  console.log(`fetched ${tickets.length} recent tickets`);
  // Discover custom field keys + sample values
  const cfValues = {};      // key -> Set of sample values
  const typeCounts = {}, priorityCounts = {}, tagCounts = {};
  for (const t of tickets) {
    for (const [k, v] of Object.entries(t.custom_fields ?? {})) {
      (cfValues[k] ??= new Map());
      if (v != null && v !== '') cfValues[k].set(String(v), (cfValues[k].get(String(v)) || 0) + 1);
    }
    typeCounts[t.type ?? 'null'] = (typeCounts[t.type ?? 'null'] || 0) + 1;
    priorityCounts[t.priority] = (priorityCounts[t.priority] || 0) + 1;
    for (const tag of (t.tags ?? [])) tagCounts[tag] = (tagCounts[tag] || 0) + 1;
  }
  console.log('\n-- custom_fields keys (non-empty value distribution) --');
  for (const [k, m] of Object.entries(cfValues)) {
    const vals = [...m.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8).map(([v,c])=>`${v}(${c})`);
    console.log(`  ${k}: ${vals.join(', ')}`);
  }
  console.log('\n-- ticket type distribution --', JSON.stringify(typeCounts));
  console.log('-- priority distribution (1=Low 2=Med 3=High 4=Urgent) --', JSON.stringify(priorityCounts));
  console.log('-- top tags --', JSON.stringify(Object.fromEntries(Object.entries(tagCounts).sort((a,b)=>b[1]-a[1]).slice(0,15))));
}

// ---------- PART B: per-persona real chat language ----------
const PERSONAS = [
  { name: 'Club customers',    kw: ['club', 'academy', 'facility', 'program', 'director', 'venue', 'organization'] },
  { name: 'Power subscribers', kw: ['power', 'subscription', 'premium', 'pro plan', 'membership', 'subscribe', 'plan'] },
  { name: 'College',           kw: ['college', 'university', 'ncaa', 'collegiate', 'recruit', 'division', 'varsity'] },
  { name: 'High school',       kw: ['high school', 'hs ', 'junior tennis', 'jtr', 'prep school', 'grade', 'school team'] },
  { name: 'Parents',           kw: ['my son', 'my daughter', 'my child', 'my kid', 'as a parent', 'my player', 'our son', 'our daughter'] },
];
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const stripPII = t => (t||'').replace(EMAIL_RE, '[email]');
const userMsgs = s => (s.logs ?? []).filter(l => l.type==='action' && l.data?.type==='text' && typeof l.data.payload==='string').map(l => l.data.payload);
const convText = s => userMsgs(s).join(' ');
function getPersona(text='') { const t=text.toLowerCase(); for (const p of PERSONAS) if (p.kw.some(k=>t.includes(k))) return p.name; return null; }
const isBounce = s => !(s.logs ?? []).some(l => l.type==='action' && l.data?.type==='text');

async function fetchWindowed(start, end) {
  const byId = new Map(); let cur = end.getTime(); const startMs = start.getTime();
  while (cur > startMs) {
    const winStart = new Date(Math.max(cur - 7*86400000 + 1, startMs));
    const r = await fetch(`${VF_ANALYTICS}/v1/transcript/project/${VF_PROJECT}`, { method:'POST', headers:vfHeaders(),
      body: JSON.stringify({ startDate: winStart.toISOString(), endDate: new Date(cur).toISOString() }) });
    const list = r.ok ? ((await r.json())?.transcripts ?? []) : [];
    for (const t of list) if (t?.id) byId.set(t.id, t);
    cur = winStart.getTime() - 1; await sleep(200);
  }
  return [...byId.values()];
}
async function inspectPersonas() {
  console.log('\n========== PART B: REAL JUNE CHAT LANGUAGE BY PERSONA ==========');
  const all = await fetchWindowed(new Date('2026-06-01T00:00:00Z'), new Date('2026-07-01T00:00:00Z'));
  for (let i=0;i<all.length;i+=10){ await Promise.all(all.slice(i,i+10).map(async t=>{
    try{const r=await fetch(`${VF_ANALYTICS}/v1/transcript/${t.id}`,{headers:vfHeaders()}); if(r.ok){const b=await r.json(); t.logs=b.logs??b.transcript?.logs??[]; t.createdAt=t.createdAt??b.createdAt;}else t.logs=[];}catch{t.logs=[];}
  })); await sleep(120);}
  const june = all.filter(t => (t.createdAt??'').slice(0,7)==='2026-06' && !isBounce(t));
  const buckets = {}; for (const p of PERSONAS) buckets[p.name]=[];
  for (const s of june){ const p=getPersona(convText(s)); if(p) buckets[p].push(s); }
  for (const p of PERSONAS){
    console.log(`\n----- ${p.name} (${buckets[p.name].length} chats) -----`);
    // sample up to 6 chats; from each, print the longest 1-2 user messages (most substantive)
    for (const s of buckets[p.name].slice(0,6)){
      const msgs = userMsgs(s).map(stripPII).filter(m=>m.length>25).sort((a,b)=>b.length-a.length).slice(0,2);
      for (const m of msgs) console.log('   • ' + m.slice(0,220).replace(/\s+/g,' '));
    }
  }
}

(async () => {
  if (!FD_KEY) console.log('WARN: FRESHDESK_KEY not set');
  if (!VF_KEY) console.log('WARN: VOICEFLOW_KEY not set');
  try { await inspectFreshdesk(); } catch(e){ console.log('Freshdesk error:', e.message); }
  try { await inspectPersonas(); } catch(e){ console.log('Persona error:', e.message); }
})();
