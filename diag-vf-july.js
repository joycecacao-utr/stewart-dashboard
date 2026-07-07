// TEMP DIAGNOSTIC — dump Voiceflow evaluations for July 2026 transcripts.
// Answers: do July transcripts have a "Deflection rate (strict)" evaluation yet?
const VF_KEY      = process.env.VOICEFLOW_KEY;
const VF_PROJECT  = '69ebd4159a532921bd258f8d';
const VF_ANALYTICS = 'https://analytics-api.voiceflow.com';
const vfHeaders = () => ({ authorization: VF_KEY, 'content-type': 'application/json', accept: 'application/json' });

(async () => {
  if (!VF_KEY) throw new Error('VOICEFLOW_KEY not set');
  const startDate = new Date('2026-07-01T00:00:00Z');
  const endDate   = new Date(); // now

  // Fetch July transcript list
  const listRes = await fetch(`${VF_ANALYTICS}/v1/transcript/project/${VF_PROJECT}`, {
    method: 'POST', headers: vfHeaders(),
    body: JSON.stringify({ startDate: startDate.toISOString(), endDate: endDate.toISOString() }),
  });
  const listBody = await listRes.json();
  const transcripts = listBody?.transcripts ?? [];
  console.log(`July 1 → now: ${transcripts.length} transcripts listed (status ${listRes.status})`);

  const evalNameCounts = {};       // distinct evaluation names across all July transcripts
  const strictValues   = {};       // value distribution for "Deflection rate (strict)"
  let withAnyEval = 0, withStrict = 0;
  const byDay = {};

  let i = 0;
  for (const t of transcripts) {
    i++;
    const r = await fetch(`${VF_ANALYTICS}/v1/transcript/${t.id}`, { headers: vfHeaders() });
    if (!r.ok) { console.log(`  [${i}] ${t.id} detail HTTP ${r.status}`); continue; }
    const body = await r.json();
    const evals = body.evaluations ?? body.transcript?.evaluations ?? [];
    const created = body.createdAt ?? body.transcript?.createdAt ?? t.createdAt;
    const day = created ? new Date(created).toISOString().slice(0,10) : '??';
    byDay[day] = (byDay[day]||0)+1;
    if (evals.length) withAnyEval++;
    for (const e of evals) {
      const name = e?.name ?? '(unnamed)';
      evalNameCounts[name] = (evalNameCounts[name]||0)+1;
      if (/deflection rate \(strict\)/i.test(name)) {
        withStrict++;
        const v = String(e.value ?? '').trim().toLowerCase() || '(empty)';
        strictValues[v] = (strictValues[v]||0)+1;
      }
    }
  }

  console.log('\n=== July transcripts by day ===');
  console.log(JSON.stringify(byDay, null, 1));
  console.log(`\nTranscripts with ANY evaluation: ${withAnyEval}/${transcripts.length}`);
  console.log(`Transcripts with "Deflection rate (strict)": ${withStrict}`);
  console.log('\n=== All evaluation names seen (July) ===');
  console.log(JSON.stringify(evalNameCounts, null, 1));
  console.log('\n=== "Deflection rate (strict)" value distribution ===');
  console.log(JSON.stringify(strictValues, null, 1));
})();
