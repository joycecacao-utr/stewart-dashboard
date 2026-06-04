#!/usr/bin/env node
// vf-probe.js — TEMPORARY. Round 4: dump the full `logs` array of an engaged
// transcript so we can see user-message vs bot-reply shape. Delete after.

const VF_KEY = process.env.VOICEFLOW_KEY;
const PID    = '69ebd4159a532921bd258f8d';
const BASE = 'https://analytics-api.voiceflow.com';
const H = { authorization: VF_KEY, 'content-type': 'application/json', accept: 'application/json' };
const end = new Date().toISOString();
const start = new Date(Date.now() - 7 * 86400000).toISOString();

const lr = await fetch(`${BASE}/v1/transcript/project/${PID}`,
  { method: 'POST', headers: H, body: JSON.stringify({ startDate: start, endDate: end }) });
const list = (await lr.json()).transcripts ?? [];
console.log('transcripts in 7d:', list.length);

// Fetch a few, pick the one with the most logs / interactions
let best = null;
for (const t of list.slice(0, 8)) {
  const r = await fetch(`${BASE}/v1/transcript/${t.id}`, { headers: H });
  if (!r.ok) continue;
  const tr = (await r.json()).transcript;
  console.log(`id ${t.id} · interactionCount ${tr.interactionCount} · logs ${tr.logs?.length ?? 0}`);
  if (!best || (tr.logs?.length ?? 0) > (best.logs?.length ?? 0)) best = tr;
}

if (best) {
  console.log('\n=== FULL logs for transcript', best.id, '(interactionCount', best.interactionCount, ') ===');
  (best.logs ?? []).forEach((l, i) => {
    console.log(`\n[${i}] type=${l.type}`);
    console.log('   ' + JSON.stringify(l).slice(0, 500));
  });
}
