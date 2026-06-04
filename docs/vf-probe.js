#!/usr/bin/env node
// vf-probe.js — TEMPORARY diagnostic. Tries several Voiceflow Transcripts API
// request shapes and logs status + a snippet of each response, so we can see
// which variant works. Run via the "Probe Voiceflow" workflow, then delete.

const VF_KEY = process.env.VOICEFLOW_KEY;
const PID    = '69ebdbdd003c5c7a49123a84';

if (!VF_KEY) { console.error('VOICEFLOW_KEY not set'); process.exit(1); }
console.log('Key prefix:', VF_KEY.slice(0, 6), '· length:', VF_KEY.length);

const base = `https://api.voiceflow.com/v2/transcripts/${PID}`;

const variants = [
  { name: '1. plain, raw auth',          url: base,                       headers: { Authorization: VF_KEY } },
  { name: '2. plain, accept json',       url: base,                       headers: { Authorization: VF_KEY, accept: 'application/json' } },
  { name: '3. ?limit=100',               url: `${base}?limit=100`,        headers: { Authorization: VF_KEY, accept: 'application/json' } },
  { name: '4. Bearer auth',              url: base,                       headers: { Authorization: `Bearer ${VF_KEY}`, accept: 'application/json' } },
  { name: '5. project-level list',       url: `https://api.voiceflow.com/v2/transcripts?projectID=${PID}`, headers: { Authorization: VF_KEY, accept: 'application/json' } },
  { name: '6. analytics base',           url: `https://api.voiceflow.com/v2/projects/${PID}/transcripts`, headers: { Authorization: VF_KEY, accept: 'application/json' } },
];

for (const v of variants) {
  try {
    const res  = await fetch(v.url, { headers: v.headers });
    const text = await res.text();
    let shape = '';
    try {
      const j = JSON.parse(text);
      if (Array.isArray(j)) shape = `array[${j.length}]` + (j[0] ? ' keys=' + Object.keys(j[0]).join(',') : '');
      else shape = 'object keys=' + Object.keys(j).join(',');
    } catch { shape = '(non-JSON)'; }
    console.log(`\n${v.name}\n  ${v.url}\n  HTTP ${res.status} · ${shape}\n  body: ${text.slice(0, 300)}`);
  } catch (e) {
    console.log(`\n${v.name}\n  ${v.url}\n  THREW: ${e.message}`);
  }
}
