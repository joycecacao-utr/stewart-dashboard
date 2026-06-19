#!/usr/bin/env node
// vf-eval-diag.js — TEMPORARY diagnostic to discover the shape of Voiceflow's
// per-transcript evaluation results (e.g. "Deflection rate (strict)").
// Hits Voiceflow only; writes nothing. Safe to delete after the field is mapped.
// Env: VOICEFLOW_KEY (required). Optional: DIAG_TID (a known evaluated transcript id).

const VF_KEY       = process.env.VOICEFLOW_KEY;
const VF_PROJECT   = '69ebd4159a532921bd258f8d';
const VF_ANALYTICS = 'https://analytics-api.voiceflow.com';
const DIAG_TID     = process.env.DIAG_TID || 'h6bzr7reaiclwfz4cjxtprv';

const headers = { authorization: VF_KEY, 'content-type': 'application/json', accept: 'application/json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Drop logs (PII + bulk) but keep everything else so we can see the eval block.
function stripLogs(o) {
  if (!o || typeof o !== 'object') return o;
  const { logs, ...rest } = o;
  return rest;
}

// Walk an object and report any key path whose name OR string value mentions eval/deflect/score.
function findEvalPaths(obj, prefix = '', out = []) {
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (/eval|deflect|score|resolut|criteri/i.test(k)) out.push({ path, type: Array.isArray(v) ? 'array' : typeof v });
    if (typeof v === 'string' && /deflect|resolut/i.test(v)) out.push({ path, value: v.slice(0, 120) });
    if (v && typeof v === 'object') findEvalPaths(v, path, out);
  }
  return out;
}

async function getTranscript(id) {
  const r = await fetch(`${VF_ANALYTICS}/v1/transcript/${id}`, { headers });
  if (!r.ok) return { error: `HTTP ${r.status}` };
  return r.json();
}

async function main() {
  if (!VF_KEY) { console.error('VOICEFLOW_KEY not set'); process.exit(1); }

  // 1) The known evaluated transcript — full dump (minus logs).
  console.log(`\n=== KNOWN TRANSCRIPT ${DIAG_TID} ===`);
  const body = await getTranscript(DIAG_TID);
  if (body.error) {
    console.log('  fetch failed:', body.error, '— falling back to recent-window scan only');
  } else {
    console.log('top-level keys:', Object.keys(body));
    if (body.transcript) console.log('transcript keys:', Object.keys(body.transcript));
    console.log('--- eval-related paths found ---');
    console.log(JSON.stringify(findEvalPaths(body), null, 2));
    console.log('--- full body (logs removed) ---');
    const dump = stripLogs(body);
    if (dump.transcript) dump.transcript = stripLogs(dump.transcript);
    console.log(JSON.stringify(dump, null, 2).slice(0, 12000));
  }

  // 2) Coverage scan: how many recent transcripts actually carry an eval result?
  const end = new Date();
  const start = new Date(end - 14 * 86400000);
  const listResp = await fetch(`${VF_ANALYTICS}/v1/transcript/project/${VF_PROJECT}`, {
    method: 'POST', headers,
    body: JSON.stringify({ startDate: start.toISOString(), endDate: end.toISOString() }),
  });
  const list = listResp.ok ? ((await listResp.json()).transcripts ?? []) : [];
  console.log(`\n=== COVERAGE SCAN: ${list.length} transcripts in last 14d ===`);
  let withEval = 0, checked = 0;
  for (const t of list.slice(0, 40)) {
    if (!t?.id) continue;
    const b = await getTranscript(t.id);
    checked++;
    const paths = b.error ? [] : findEvalPaths(stripLogs(b));
    if (paths.length) withEval++;
    await sleep(80);
  }
  console.log(`checked ${checked}, ${withEval} carried eval-related fields`);
}

main().catch(e => { console.error(e); process.exit(1); });
