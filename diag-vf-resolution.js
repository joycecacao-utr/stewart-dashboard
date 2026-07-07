// TEMP DIAGNOSTIC — validate a programmatic AI-resolution signal on full months.
// Uses the SAME weekly-window fetch as fetch-css-data.js to avoid VF's per-request
// cap, so counts match the real pipeline. Buckets by transcript createdAt month.
const VF_KEY       = process.env.VOICEFLOW_KEY;
const VF_PROJECT   = '69ebd4159a532921bd258f8d';
const VF_ANALYTICS = 'https://analytics-api.voiceflow.com';
const vfHeaders = () => ({ authorization: VF_KEY, 'content-type': 'application/json', accept: 'application/json' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ESC_KEYWORDS = ['agent', 'human', 'transfer', 'escalat', 'live chat', 'speak to', 'talk to someone'];
const isBounce = s => !(s.logs ?? []).some(l => l.type === 'action' && l.data?.type === 'text');
const createdTicket = s => JSON.stringify(s.logs ?? []).includes('freshdesk_create_ticket');
const keywordEscalated = s => {
  const userText = (s.logs ?? [])
    .filter(l => l.type === 'action' && l.data?.type === 'text' && typeof l.data.payload === 'string')
    .map(l => l.data.payload).join(' ').toLowerCase();
  return ESC_KEYWORDS.some(kw => userText.includes(kw));
};
const deflection = s => {
  const ev = (s.evaluations ?? []).find(e => /deflection rate \(strict\)/i.test(e?.name ?? ''));
  if (!ev) return null;
  const v = String(ev.value ?? '').trim().toLowerCase();
  return (v === 'pass' || v === 'fail') ? v : (v === 'na' || v === 'n/a') ? 'na' : null;
};

// Weekly windows spanning [start, end); mirrors vfGetAll's approach.
async function fetchWindowed(start, end) {
  const byId = new Map();
  let cur = end.getTime();
  const startMs = start.getTime();
  let maxWin = 0;
  while (cur > startMs) {
    const winEnd = new Date(cur);
    const winStart = new Date(Math.max(cur - 7 * 86400000 + 1, startMs));
    const r = await fetch(`${VF_ANALYTICS}/v1/transcript/project/${VF_PROJECT}`, {
      method: 'POST', headers: vfHeaders(),
      body: JSON.stringify({ startDate: winStart.toISOString(), endDate: winEnd.toISOString() }),
    });
    const list = r.ok ? ((await r.json())?.transcripts ?? []) : [];
    maxWin = Math.max(maxWin, list.length);
    for (const t of list) if (t?.id) byId.set(t.id, t);
    cur = winStart.getTime() - 1;
    await sleep(200);
  }
  console.log(`  windows done: ${byId.size} unique transcripts (max ${maxWin}/window)`);
  return [...byId.values()];
}

async function hydrate(all) {
  for (let i = 0; i < all.length; i += 10) {
    const chunk = all.slice(i, i + 10);
    await Promise.all(chunk.map(async t => {
      try {
        const r = await fetch(`${VF_ANALYTICS}/v1/transcript/${t.id}`, { headers: vfHeaders() });
        if (r.ok) { const b = await r.json();
          t.logs = b.logs ?? b.transcript?.logs ?? [];
          t.evaluations = b.evaluations ?? b.transcript?.evaluations ?? [];
          t.createdAt = t.createdAt ?? b.createdAt ?? b.transcript?.createdAt;
        } else t.logs = [];
      } catch { t.logs = []; }
    }));
    await sleep(150);
  }
}

function report(month, list) {
  const inMonth = list.filter(t => (t.createdAt ?? '').slice(0, 7) === month);
  const engaged = inMonth.filter(s => !isBounce(s));
  const nTicket = engaged.filter(createdTicket).length;
  const nKw = engaged.filter(keywordEscalated).length;
  const nKwOnly = engaged.filter(s => keywordEscalated(s) && !createdTicket(s)).length;
  const nEither = engaged.filter(s => createdTicket(s) || keywordEscalated(s)).length;
  const dist = { pass: 0, fail: 0, na: 0, none: 0 };
  for (const s of engaged) dist[deflection(s) ?? 'none']++;
  const pct = (n, d) => d ? (100 * n / d).toFixed(1) + '%' : 'n/a';
  const vfDen = dist.pass + dist.fail;
  console.log(`\n================ ${month} ================`);
  console.log(`transcripts in month: ${inMonth.length}   engaged (non-bounce): ${engaged.length}`);
  console.log(`Created Freshdesk ticket : ${nTicket} (${pct(nTicket, engaged.length)} of engaged)`);
  console.log(`Keyword escalated        : ${nKw}   (keyword-but-no-ticket: ${nKwOnly})`);
  console.log(`Either ticket|keyword    : ${nEither} (${pct(nEither, engaged.length)})`);
  console.log(`--> AI Resolution %, ticket-only  : ${pct(engaged.length - nTicket, engaged.length)}`);
  console.log(`--> AI Resolution %, ticket|keyword: ${pct(engaged.length - nEither, engaged.length)}`);
  console.log(`VF deflection: pass=${dist.pass} fail=${dist.fail} na=${dist.na} unscored=${dist.none} -> rate ${pct(dist.pass, vfDen)} (den ${vfDen})`);
}

(async () => {
  if (!VF_KEY) throw new Error('VOICEFLOW_KEY not set');
  const start = new Date('2026-05-01T00:00:00Z');
  const end   = new Date('2026-07-01T00:00:00Z');
  console.log('Fetching May 1 → July 1 in weekly windows...');
  const all = await fetchWindowed(start, end);
  console.log(`Hydrating ${all.length} transcript details...`);
  await hydrate(all);
  report('2026-05', all);
  report('2026-06', all);
})();
