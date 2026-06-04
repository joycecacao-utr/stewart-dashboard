#!/usr/bin/env node
// vf-probe.js — TEMPORARY. Tests the NEW Voiceflow analytics transcripts API
// (July 2025). Prints the raw list response, then probes candidate endpoints
// for a single transcript's turns. Delete after we confirm the shapes.

const VF_KEY = process.env.VOICEFLOW_KEY;
const PID    = '69ebd4159a532921bd258f8d';
if (!VF_KEY) { console.error('VOICEFLOW_KEY not set'); process.exit(1); }

const BASE = 'https://analytics-api.voiceflow.com';
const end   = new Date().toISOString();
const start = new Date(Date.now() - 7 * 86400000).toISOString();
console.log('Key prefix:', VF_KEY.slice(0, 6), '· range', start, '→', end);

// ── 1. List transcripts (POST) ────────────────────────────────────────────
const listUrl = `${BASE}/v1/transcript/project/${PID}`;
console.log('\n=== LIST: POST', listUrl, '===');
let transcripts = [];
try {
  const res = await fetch(listUrl, {
    method: 'POST',
    headers: { authorization: VF_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ startDate: start, endDate: end }),
  });
  const text = await res.text();
  console.log('HTTP', res.status);
  console.log('raw (first 1200 chars):', text.slice(0, 1200));
  try {
    const j = JSON.parse(text);
    transcripts = j.transcripts ?? (Array.isArray(j) ? j : []);
    console.log('\nparsed: transcripts count =', transcripts.length);
    if (transcripts[0]) console.log('first transcript keys:', Object.keys(transcripts[0]).join(','));
    if (transcripts[0]) console.log('first transcript:', JSON.stringify(transcripts[0]).slice(0, 500));
  } catch { console.log('(non-JSON body)'); }
} catch (e) { console.log('THREW:', e.message); }

// ── 2. Probe single-transcript turns endpoints ─────────────────────────────
if (transcripts[0]) {
  const t = transcripts[0];
  const id = t.id ?? t._id ?? t.transcriptID;
  const sid = t.sessionID ?? t.sessionId;
  console.log('\n=== TURNS probes for transcript id =', id, '· sessionID =', sid, '===');
  const candidates = [
    { m: 'GET',  u: `${BASE}/v1/transcript/project/${PID}/transcript/${id}` },
    { m: 'GET',  u: `${BASE}/v1/transcript/project/${PID}/${id}` },
    { m: 'GET',  u: `${BASE}/v1/transcript/${id}` },
    { m: 'GET',  u: `${BASE}/v1/transcript/project/${PID}/transcript/${id}/dialog` },
    { m: 'GET',  u: `${BASE}/v1/transcript/project/${PID}/session/${sid}` },
    { m: 'POST', u: `${BASE}/v1/transcript/project/${PID}/transcript/${id}` },
  ];
  for (const c of candidates) {
    try {
      const opts = { method: c.m, headers: { authorization: VF_KEY, accept: 'application/json' } };
      if (c.m === 'POST') { opts.headers['content-type'] = 'application/json'; opts.body = '{}'; }
      const res = await fetch(c.u, opts);
      const text = await res.text();
      let shape = '(non-JSON)';
      try {
        const j = JSON.parse(text);
        if (Array.isArray(j)) shape = `array[${j.length}]` + (j[0] ? ' itemKeys=' + Object.keys(j[0]).join(',') : '');
        else shape = 'object keys=' + Object.keys(j).join(',');
      } catch {}
      console.log(`\n${c.m} ${c.u}\n  HTTP ${res.status} · ${shape}\n  raw: ${text.slice(0, 400)}`);
    } catch (e) { console.log(`\n${c.m} ${c.u}\n  THREW: ${e.message}`); }
  }
}
