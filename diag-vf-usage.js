// Read-only diagnostic: pull TRUE monthly session/interaction counts from the
// Voiceflow Analytics usage API (the aggregate behind the dashboard donut),
// instead of the under-sampled transcript list. Prints raw results; never writes.
const VF_KEY       = process.env.VOICEFLOW_KEY;
const VF_PROJECT   = '69ebd4159a532921bd258f8d';
const VF_ANALYTICS = 'https://analytics-api.voiceflow.com';
const headers = () => ({ authorization: VF_KEY, 'content-type': 'application/json', accept: 'application/json' });

const MONTHS = [
  ['2026-06', '2026-06-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'],
  ['2026-07', '2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'],
  ['2026-08', '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'],
];
// Candidate metric names to probe — we'll see which the API accepts + which
// matches the ~1,400 August figure from the dashboard.
const METRICS = ['sessions', 'interactions', 'unique_users', 'understood_messages', 'token_usage', 'transcripts'];

async function queryUsage(metric, startTime, endTime) {
  const body = { query: [{ name: metric, filter: { projectID: VF_PROJECT, startTime, endTime } }] };
  const r = await fetch(`${VF_ANALYTICS}/v1/query/usage`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, text };
}

(async () => {
  if (!VF_KEY) { console.error('VOICEFLOW_KEY not set'); process.exit(1); }
  console.log('===== VF USAGE ANALYTICS PROBE =====');
  for (const [label, start, end] of MONTHS) {
    console.log(`\n### ${label} (${start} → ${end})`);
    for (const metric of METRICS) {
      try {
        const { status, text } = await queryUsage(metric, start, end);
        console.log(`  [${metric}] HTTP ${status}: ${text.slice(0, 400)}`);
      } catch (e) {
        console.log(`  [${metric}] ERROR: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 400));
    }
  }
  console.log('\n===== DONE =====');
})();
