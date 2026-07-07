// TEMP DIAGNOSTIC — inspect HOW 'freshdesk_create_ticket' appears in logs, to tell
// an executed handoff from mere flow scaffolding. June 2026, weekly-windowed.
const VF_KEY       = process.env.VOICEFLOW_KEY;
const VF_PROJECT   = '69ebd4159a532921bd258f8d';
const VF_ANALYTICS = 'https://analytics-api.voiceflow.com';
const vfHeaders = () => ({ authorization: VF_KEY, 'content-type': 'application/json', accept: 'application/json' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isBounce = s => !(s.logs ?? []).some(l => l.type === 'action' && l.data?.type === 'text');

async function fetchWindowed(start, end) {
  const byId = new Map(); let cur = end.getTime(); const startMs = start.getTime();
  while (cur > startMs) {
    const winStart = new Date(Math.max(cur - 7 * 86400000 + 1, startMs));
    const r = await fetch(`${VF_ANALYTICS}/v1/transcript/project/${VF_PROJECT}`, {
      method: 'POST', headers: vfHeaders(),
      body: JSON.stringify({ startDate: winStart.toISOString(), endDate: new Date(cur).toISOString() }),
    });
    const list = r.ok ? ((await r.json())?.transcripts ?? []) : [];
    for (const t of list) if (t?.id) byId.set(t.id, t);
    cur = winStart.getTime() - 1; await sleep(200);
  }
  return [...byId.values()];
}
async function hydrate(all) {
  for (let i = 0; i < all.length; i += 10) {
    await Promise.all(all.slice(i, i + 10).map(async t => {
      try { const r = await fetch(`${VF_ANALYTICS}/v1/transcript/${t.id}`, { headers: vfHeaders() });
        if (r.ok) { const b = await r.json();
          t.logs = b.logs ?? b.transcript?.logs ?? [];
          t.createdAt = t.createdAt ?? b.createdAt ?? b.transcript?.createdAt; } else t.logs = [];
      } catch { t.logs = []; }
    })); await sleep(150);
  }
}

(async () => {
  if (!VF_KEY) throw new Error('VOICEFLOW_KEY not set');
  const all = await fetchWindowed(new Date('2026-06-01T00:00:00Z'), new Date('2026-07-01T00:00:00Z'));
  await hydrate(all);
  const june = all.filter(t => (t.createdAt ?? '').slice(0, 7) === '2026-06');
  const engaged = june.filter(s => !isBounce(s));
  console.log(`June engaged: ${engaged.length}`);

  // For each engaged transcript, find log entries mentioning freshdesk_create_ticket
  // and record the (type / data.type) of the matching entry.
  const entryKinds = {};        // "type|data.type" -> count of transcripts with a match of that kind
  let anyMatch = 0;
  const samples = [];
  for (const s of engaged) {
    const matches = (s.logs ?? []).filter(l => JSON.stringify(l).includes('freshdesk_create_ticket'));
    if (matches.length) anyMatch++;
    const kinds = new Set(matches.map(l => `${l.type}|${l.data?.type ?? ''}`));
    for (const k of kinds) entryKinds[k] = (entryKinds[k] || 0) + 1;
    if (samples.length < 3 && matches.length) {
      samples.push(matches.map(l => {
        const j = JSON.stringify(l);
        return `${l.type}|${l.data?.type ?? ''}  ::  ${j.slice(0, 240)}`;
      }));
    }
  }
  console.log(`Engaged transcripts containing 'freshdesk_create_ticket' anywhere: ${anyMatch}/${engaged.length}`);
  console.log(`\n=== matching entry kinds (type|data.type -> # transcripts) ===`);
  console.log(JSON.stringify(entryKinds, null, 1));

  // Also: does EVERY transcript (even bounces / clearly-resolved) contain the string?
  // If the string is in flow scaffolding it'll appear in ~all transcripts regardless.
  const allMention = all.filter(t => JSON.stringify(t.logs ?? []).includes('freshdesk_create_ticket')).length;
  console.log(`\nALL transcripts (incl. bounces) mentioning the string: ${allMention}/${all.length}`);

  // Look for an executed-action / trace signal specifically (Voiceflow marks executed
  // integration steps differently from flow definitions). Dump distinct debug messages
  // that reference tickets, to find a reliable "ticket was actually created" marker.
  const debugMsgs = {};
  for (const s of engaged) for (const l of (s.logs ?? [])) {
    if (l.type === 'trace' || l.data?.type === 'debug' || l.type === 'debug') {
      const msg = (l.data?.payload?.message ?? l.payload?.message ?? '').toString();
      if (/ticket|freshdesk|escalat|agent|handoff|transfer/i.test(msg)) {
        const key = msg.slice(0, 80);
        debugMsgs[key] = (debugMsgs[key] || 0) + 1;
      }
    }
  }
  console.log(`\n=== ticket/handoff-related debug messages (first 80 chars -> count) ===`);
  console.log(JSON.stringify(debugMsgs, null, 1));

  console.log(`\n=== sample matching entries (up to 3 transcripts) ===`);
  samples.forEach((arr, i) => { console.log(`--- transcript ${i + 1} ---`); arr.forEach(x => console.log('   ' + x)); });
})();
