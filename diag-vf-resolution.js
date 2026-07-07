// TEMP DIAGNOSTIC — validate a programmatic AI-resolution signal on June 2026.
// Goal: how reliable is "bot created a Freshdesk ticket" as the escalation signal,
// how does the keyword rule compare, and how do the resulting resolution %s compare
// to Voiceflow's own "Deflection rate (strict)" evaluation.
const VF_KEY       = process.env.VOICEFLOW_KEY;
const VF_PROJECT   = '69ebd4159a532921bd258f8d';
const VF_ANALYTICS = 'https://analytics-api.voiceflow.com';
const vfHeaders = () => ({ authorization: VF_KEY, 'content-type': 'application/json', accept: 'application/json' });

const ESC_KEYWORDS = ['agent', 'human', 'transfer', 'escalat', 'live chat', 'speak to', 'talk to someone'];

function isBounce(s) {
  return !(s.logs ?? []).some(l => l.type === 'action' && l.data?.type === 'text');
}
function createdTicket(s) {
  return JSON.stringify(s.logs ?? []).includes('freshdesk_create_ticket');
}
function keywordEscalated(s) {
  const userText = (s.logs ?? [])
    .filter(l => l.type === 'action' && l.data?.type === 'text' && typeof l.data.payload === 'string')
    .map(l => l.data.payload).join(' ').toLowerCase();
  return ESC_KEYWORDS.some(kw => userText.includes(kw));
}
function deflection(s) {
  const ev = (s.evaluations ?? []).find(e => /deflection rate \(strict\)/i.test(e?.name ?? ''));
  if (!ev) return null;
  const v = String(ev.value ?? '').trim().toLowerCase();
  return (v === 'pass' || v === 'fail') ? v : (v === 'na' || v === 'n/a') ? 'na' : null;
}

(async () => {
  if (!VF_KEY) throw new Error('VOICEFLOW_KEY not set');
  const startDate = new Date('2026-06-01T00:00:00Z');
  const endDate   = new Date('2026-07-01T00:00:00Z');

  const listRes = await fetch(`${VF_ANALYTICS}/v1/transcript/project/${VF_PROJECT}`, {
    method: 'POST', headers: vfHeaders(),
    body: JSON.stringify({ startDate: startDate.toISOString(), endDate: endDate.toISOString() }),
  });
  const transcripts = (await listRes.json())?.transcripts ?? [];
  console.log(`June 1 → July 1: ${transcripts.length} transcripts (status ${listRes.status})`);

  // fetch details in batches of 10
  const detailed = [];
  for (let i = 0; i < transcripts.length; i += 10) {
    const batch = transcripts.slice(i, i + 10);
    const rs = await Promise.all(batch.map(t =>
      fetch(`${VF_ANALYTICS}/v1/transcript/${t.id}`, { headers: vfHeaders() })
        .then(r => r.ok ? r.json() : null).catch(() => null)));
    for (const body of rs) {
      if (!body) continue;
      detailed.push({
        logs: body.logs ?? body.transcript?.logs ?? [],
        evaluations: body.evaluations ?? body.transcript?.evaluations ?? [],
      });
    }
  }
  console.log(`Fetched ${detailed.length} transcript details`);

  const engaged = detailed.filter(s => !isBounce(s));
  const nTicket  = engaged.filter(createdTicket).length;
  const nKeyword = engaged.filter(keywordEscalated).length;
  const nEither  = engaged.filter(s => createdTicket(s) || keywordEscalated(s)).length;
  const nBoth    = engaged.filter(s => createdTicket(s) && keywordEscalated(s)).length;
  const nKeywordOnly = engaged.filter(s => keywordEscalated(s) && !createdTicket(s)).length;

  // VF deflection distribution over engaged
  const dist = { pass: 0, fail: 0, na: 0, none: 0 };
  for (const s of engaged) { const d = deflection(s); dist[d ?? 'none']++; }

  const pctOf = (n, d) => d ? (100 * n / d).toFixed(1) + '%' : 'n/a';

  console.log('\n=== June 2026 (engaged = non-bounce) ===');
  console.log(`Total transcripts: ${detailed.length}   Engaged: ${engaged.length}`);
  console.log(`\n-- Escalation signals (count / % of engaged) --`);
  console.log(`  Created Freshdesk ticket : ${nTicket}  (${pctOf(nTicket, engaged.length)})`);
  console.log(`  Keyword escalated        : ${nKeyword} (${pctOf(nKeyword, engaged.length)})`);
  console.log(`  Keyword but NO ticket    : ${nKeywordOnly}`);
  console.log(`  Both ticket & keyword    : ${nBoth}`);
  console.log(`  Either (ticket|keyword)  : ${nEither} (${pctOf(nEither, engaged.length)})`);

  console.log(`\n-- Resulting AI Resolution % (engaged not escalated / engaged) --`);
  console.log(`  A) ticket-only signal    : ${pctOf(engaged.length - nTicket, engaged.length)}`);
  console.log(`  B) ticket OR keyword     : ${pctOf(engaged.length - nEither, engaged.length)}`);

  console.log(`\n-- Voiceflow "Deflection rate (strict)" over engaged --`);
  console.log(`  pass=${dist.pass} fail=${dist.fail} na=${dist.na} none(unscored)=${dist.none}`);
  const vfDen = dist.pass + dist.fail;
  console.log(`  VF deflection rate = pass/(pass+fail) = ${pctOf(dist.pass, vfDen)}  (den ${vfDen})`);

  // Sample: distinct log 'action' request types + any tokens hinting handoff, to sanity-check the signal name
  const reqTypes = {};
  const handoffHints = new Set();
  for (const s of detailed) for (const l of (s.logs ?? [])) {
    const t = l?.data?.type ?? l?.type;
    if (t) reqTypes[t] = (reqTypes[t] || 0) + 1;
    const blob = JSON.stringify(l).toLowerCase();
    for (const tok of ['freshdesk', 'create_ticket', 'handoff', 'handover', 'live_agent', 'transfer'])
      if (blob.includes(tok)) handoffHints.add(tok);
  }
  console.log(`\n-- log entry data.type distribution --`);
  console.log(JSON.stringify(reqTypes, null, 1));
  console.log(`-- handoff-related tokens seen in logs --`);
  console.log([...handoffHints].join(', ') || '(none)');
})();
