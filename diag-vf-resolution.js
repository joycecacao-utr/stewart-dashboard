// TEMP DIAGNOSTIC — precise resolution rate. A chat is "escalated" iff a Freshdesk
// ticket was ACTUALLY submitted (success trace / user-facing confirmation), not merely
// referenced in flow scaffolding. May + June 2026, weekly-windowed.
const VF_KEY       = process.env.VOICEFLOW_KEY;
const VF_PROJECT   = '69ebd4159a532921bd258f8d';
const VF_ANALYTICS = 'https://analytics-api.voiceflow.com';
const vfHeaders = () => ({ authorization: VF_KEY, 'content-type': 'application/json', accept: 'application/json' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isBounce = s => !(s.logs ?? []).some(l => l.type === 'action' && l.data?.type === 'text');

// Signals
const blob = s => JSON.stringify(s.logs ?? []);
const strAnywhere = s => blob(s).includes('freshdesk_create_ticket');
const toolSucceeded = s => /"(freshdesk_create_ticket|create_freshdesk_ticket|freshdesk_create_ticket_api)"\s+succeeded/i.test(blob(s));
const userConfirmed = s => /support ticket has been submitted|solicitud ha sido enviada/i.test(blob(s));
const ticketSubmitted = s => toolSucceeded(s) || userConfirmed(s); // "escalated" = real ticket

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
function report(month, list) {
  const inMonth = list.filter(t => (t.createdAt ?? '').slice(0, 7) === month);
  const engaged = inMonth.filter(s => !isBounce(s));
  const nAny = engaged.filter(strAnywhere).length;
  const nSucceeded = engaged.filter(toolSucceeded).length;
  const nUser = engaged.filter(userConfirmed).length;
  const nSubmitted = engaged.filter(ticketSubmitted).length;
  const pct = (n, d) => d ? (100 * n / d).toFixed(1) + '%' : 'n/a';
  console.log(`\n============ ${month} ============`);
  console.log(`engaged (non-bounce): ${engaged.length}`);
  console.log(`  string anywhere        : ${nAny}  (crude)`);
  console.log(`  tool "succeeded" trace : ${nSucceeded}`);
  console.log(`  user-facing "submitted": ${nUser}`);
  console.log(`  => ticket ACTUALLY submitted (succeeded OR user-confirmed): ${nSubmitted} (${pct(nSubmitted, engaged.length)} of engaged)`);
  console.log(`  ================================================`);
  console.log(`  AI Resolution % (crude string)     : ${pct(engaged.length - nAny, engaged.length)}`);
  console.log(`  AI Resolution % (real ticket)      : ${pct(engaged.length - nSubmitted, engaged.length)}   <-- proposed`);
}
(async () => {
  if (!VF_KEY) throw new Error('VOICEFLOW_KEY not set');
  const all = await fetchWindowed(new Date('2026-05-01T00:00:00Z'), new Date('2026-07-01T00:00:00Z'));
  await hydrate(all);
  report('2026-05', all);
  report('2026-06', all);
})();
