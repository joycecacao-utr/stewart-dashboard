#!/usr/bin/env node
// vf-probe.js — TEMPORARY. Round 2: confirm where conversation turns live and
// check list pagination on the new Voiceflow analytics API. Delete after.

const VF_KEY = process.env.VOICEFLOW_KEY;
const PID    = '69ebd4159a532921bd258f8d';
if (!VF_KEY) { console.error('VOICEFLOW_KEY not set'); process.exit(1); }

const BASE = 'https://analytics-api.voiceflow.com';
const H = { authorization: VF_KEY, 'content-type': 'application/json', accept: 'application/json' };
const end   = new Date().toISOString();
const start = new Date(Date.now() - 7 * 86400000).toISOString();

async function show(label, url, opts) {
  try {
    const res = await fetch(url, opts);
    const text = await res.text();
    console.log(`\n${label}\n  ${opts.method} ${url}\n  HTTP ${res.status}\n  ${text.slice(0, 1800)}`);
    try { return JSON.parse(text); } catch { return null; }
  } catch (e) { console.log(`\n${label} THREW: ${e.message}`); return null; }
}

// ── LIST: top-level shape + pagination probing ─────────────────────────────
const list = await show('LIST default', `${BASE}/v1/transcript/project/${PID}`,
  { method: 'POST', headers: H, body: JSON.stringify({ startDate: start, endDate: end }) });
if (list) console.log('\nLIST top-level keys:', Object.keys(list).join(','), '· transcripts:', (list.transcripts ?? []).length);

// Try a big take/limit to see if more than 25 come back
await show('LIST take=1000', `${BASE}/v1/transcript/project/${PID}`,
  { method: 'POST', headers: H, body: JSON.stringify({ startDate: start, endDate: end, take: 1000, limit: 1000 }) });

// ── TURNS: full single-transcript dump + candidate turn endpoints ──────────
const first = (list?.transcripts ?? [])[0];
if (first) {
  const id = first.id;
  console.log('\n\n========== TURN ENDPOINTS for id =', id, '==========');
  await show('A single (full dump)', `${BASE}/v1/transcript/${id}`, { method: 'GET', headers: H });
  await show('B /dialog',  `${BASE}/v1/transcript/${id}/dialog`,  { method: 'GET', headers: H });
  await show('C /turns',   `${BASE}/v1/transcript/${id}/turns`,   { method: 'GET', headers: H });
  await show('D /messages',`${BASE}/v1/transcript/${id}/messages`,{ method: 'GET', headers: H });
  await show('E /interactions', `${BASE}/v1/transcript/${id}/interactions`, { method: 'GET', headers: H });
  await show('F project/dialog', `${BASE}/v1/transcript/project/${PID}/transcript/${id}/dialog`, { method: 'GET', headers: H });
}
