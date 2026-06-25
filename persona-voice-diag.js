#!/usr/bin/env node
// persona-voice-diag.js — TEMPORARY diagnostic. Groups Voiceflow transcripts by
// persona and dumps real (PII-stripped) customer messages per segment so we can
// synthesize an authentic first-person "collective voice" quote for each persona.
// Writes nothing. Env: VOICEFLOW_KEY. Optional: VF_LOOKBACK_DAYS (default 90).

const VF_KEY        = process.env.VOICEFLOW_KEY;
const VF_PROJECT    = '69ebd4159a532921bd258f8d';
const VF_ANALYTICS  = 'https://analytics-api.voiceflow.com';
const LOOKBACK_DAYS = parseInt(process.env.VF_LOOKBACK_DAYS || '90', 10);
const headers = { authorization: VF_KEY, 'content-type': 'application/json', accept: 'application/json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PERSONAS = [
  { name: 'Club customers',    kw: ['club', 'academy', 'facility', 'program', 'director', 'venue', 'organization'] },
  { name: 'Power subscribers', kw: ['power', 'subscription', 'premium', 'pro plan', 'membership', 'subscribe', 'plan'] },
  { name: 'College',           kw: ['college', 'university', 'ncaa', 'collegiate', 'recruit', 'division', 'varsity'] },
  { name: 'High school',       kw: ['high school', 'hs ', 'junior tennis', 'jtr', 'prep school', 'grade', 'school team'] },
  { name: 'Parents',           kw: ['my son', 'my daughter', 'my child', 'my kid', 'as a parent', 'my player', 'our son', 'our daughter'] },
];

const EMAIL_RE    = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const FULLNAME_RE = /\b(?:my name is|i(?:'m| am)|this is)\s+([A-Z][a-z]+)\s+[A-Z][a-z]+\b/gi;
const LOCATION_RE = /\b(?:in|from|at|near)\s+[A-Z][a-zA-Z\s]{2,18},?\s*(?:[A-Z]{2})?\b/g;
const stripPII = t => (t || '').replace(EMAIL_RE, '[email]').replace(FULLNAME_RE, (_, f) => f).replace(LOCATION_RE, '[location]');

function slateText(slate) {
  const out = [];
  for (const node of (slate?.content ?? []))
    for (const child of (node.children ?? []))
      if (typeof child.text === 'string') out.push(child.text);
  return out.join(' ');
}
function convText(s) {
  const parts = [];
  for (const l of (s.logs ?? [])) {
    if (l.type === 'action' && l.data?.type === 'text' && typeof l.data.payload === 'string') parts.push(l.data.payload);
    else if (l.type === 'trace' && l.data?.type === 'text' && l.data?.payload?.ai) { const t = slateText(l.data.payload.slate); if (t) parts.push(t); }
  }
  return parts.join(' ');
}
function userMessages(s) {
  return (s.logs ?? [])
    .filter(l => l.type === 'action' && l.data?.type === 'text' && typeof l.data.payload === 'string')
    .map(l => stripPII(l.data.payload).trim())
    .filter(t => t.length > 3);
}
const isBounce = s => !(s.logs ?? []).some(l => l.type === 'action' && l.data?.type === 'text');
function getPersona(text = '') {
  const t = text.toLowerCase();
  for (const p of PERSONAS) if (p.kw.some(kw => t.includes(kw))) return p.name;
  return null;
}

async function vfGetAll(days) {
  const now = Date.now();
  const numWindows = Math.ceil(days / 7);
  const byId = new Map();
  for (let b = 0; b < numWindows; b += 8) {
    const batch = [];
    for (let w = b; w < Math.min(b + 8, numWindows); w++) {
      const winEnd = new Date(now - w * 7 * 86400000);
      const winStart = new Date(Math.max(now - (w + 1) * 7 * 86400000 + 1, now - days * 86400000));
      batch.push(fetch(`${VF_ANALYTICS}/v1/transcript/project/${VF_PROJECT}`, {
        method: 'POST', headers, body: JSON.stringify({ startDate: winStart.toISOString(), endDate: winEnd.toISOString() }),
      }).then(r => r.ok ? r.json() : null).then(b => b?.transcripts ?? []));
    }
    (await Promise.all(batch)).forEach(list => list.forEach(t => { if (t?.id) byId.set(t.id, t); }));
    await sleep(80);
  }
  const all = [...byId.values()];
  for (let i = 0; i < all.length; i += 10) {
    await Promise.all(all.slice(i, i + 10).map(async t => {
      try { const r = await fetch(`${VF_ANALYTICS}/v1/transcript/${t.id}`, { headers });
        if (r.ok) { const b = await r.json(); t.logs = b.logs ?? b.transcript?.logs ?? []; } else t.logs = []; }
      catch { t.logs = []; }
    }));
    await sleep(80);
  }
  return all;
}

async function main() {
  if (!VF_KEY) { console.error('VOICEFLOW_KEY not set'); process.exit(1); }
  const sessions = await vfGetAll(LOOKBACK_DAYS);
  console.log(`Fetched ${sessions.length} transcripts (${LOOKBACK_DAYS}d)\n`);

  const buckets = {};
  for (const p of PERSONAS) buckets[p.name] = [];
  let engaged = 0;
  for (const s of sessions) {
    if (isBounce(s)) continue;
    engaged++;
    const persona = getPersona(convText(s));
    if (persona) buckets[persona].push(...userMessages(s));
  }
  console.log(`Engaged (non-bounce) transcripts: ${engaged}\n`);

  for (const p of PERSONAS) {
    const msgs = buckets[p.name];
    // Dedup + keep substantive lines, cap to a readable sample.
    const seen = new Set();
    const sample = [];
    for (const m of msgs) {
      const key = m.toLowerCase().slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      sample.push(m.length > 220 ? m.slice(0, 217) + '…' : m);
      if (sample.length >= 30) break;
    }
    console.log(`\n===== ${p.name} — ${msgs.length} customer messages (${sample.length} unique shown) =====`);
    sample.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
