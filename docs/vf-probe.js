#!/usr/bin/env node
// vf-probe.js — TEMPORARY. Round 3: locate the conversation turns inside the
// single-transcript response (or via include params). Delete after.

const VF_KEY = process.env.VOICEFLOW_KEY;
const PID    = '69ebd4159a532921bd258f8d';
if (!VF_KEY) { console.error('VOICEFLOW_KEY not set'); process.exit(1); }

const BASE = 'https://analytics-api.voiceflow.com';
const H = { authorization: VF_KEY, 'content-type': 'application/json', accept: 'application/json' };
const end = new Date().toISOString();
const start = new Date(Date.now() - 7 * 86400000).toISOString();

// Get a transcript id
const lr = await fetch(`${BASE}/v1/transcript/project/${PID}`,
  { method: 'POST', headers: H, body: JSON.stringify({ startDate: start, endDate: end }) });
const list = await lr.json();
const id = list.transcripts[0].id;
console.log('Using transcript id', id, '· total in 7d:', list.transcripts.length);

function describe(obj, label) {
  console.log(`\n--- ${label} ---`);
  if (Array.isArray(obj)) { console.log('ARRAY length', obj.length, '· first item:', JSON.stringify(obj[0]).slice(0, 600)); return; }
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v)) console.log(`  ${k}: array[${v.length}]`, v[0] ? '· first=' + JSON.stringify(v[0]).slice(0, 400) : '');
      else if (v && typeof v === 'object') console.log(`  ${k}: object{${Object.keys(v).join(',')}}`);
      else console.log(`  ${k}:`, JSON.stringify(v)?.slice(0, 120));
    }
  }
}

// A) single transcript — full key map
const a = await fetch(`${BASE}/v1/transcript/${id}`, { headers: H });
const aj = await a.json();
console.log('\n=== A GET /v1/transcript/{id} → HTTP', a.status, '===');
describe(aj.transcript ?? aj, 'transcript object');

// B) include params that might attach turns
for (const q of ['?include=logs', '?include=turns', '?include=dialog', '?logs=true', '?include=interactions']) {
  const r = await fetch(`${BASE}/v1/transcript/${id}${q}`, { headers: H });
  const t = await r.text();
  console.log(`\n=== B GET /v1/transcript/{id}${q} → HTTP ${r.status} · len ${t.length} ===\n  ${t.slice(0, 300)}`);
}

// C) candidate log endpoints (new API often uses /log or /logs)
for (const path of [
  `/v1/transcript/${id}/log`,
  `/v1/log/transcript/${id}`,
  `/v1/transcript/project/${PID}/transcript/${id}/log`,
  `/v1/transcript/${id}/content`,
  `/v2/transcripts/${PID}/${id}`,           // legacy turns endpoint, may still serve content
]) {
  const r = await fetch(`${BASE}${path}`, { headers: H });
  const t = await r.text();
  console.log(`\n=== C GET ${path} → HTTP ${r.status} · len ${t.length} ===\n  ${t.slice(0, 300)}`);
}
