// Read-only diagnostic: crack the Voiceflow usage-analytics schema for TRUE
// session/interaction counts. Tries several body shapes on August only.
const VF_KEY       = process.env.VOICEFLOW_KEY;
const VF_PROJECT   = '69ebd4159a532921bd258f8d';
const VF_ANALYTICS = 'https://analytics-api.voiceflow.com';
const headers = () => ({ authorization: VF_KEY, 'content-type': 'application/json', accept: 'application/json' });

const START = '2026-08-01T00:00:00.000Z';
const END   = '2026-09-01T00:00:00.000Z';

async function post(path, body) {
  const r = await fetch(`${VF_ANALYTICS}${path}`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  const text = await r.text();
  return `HTTP ${r.status}: ${text.slice(0, 500)}`;
}

const shapes = [
  ['interactions + env=production', '/v1/query/usage',
    { query: [{ name: 'interactions', filter: { projectID: VF_PROJECT, startTime: START, endTime: END, projectEnvironmentIDOrAlias: 'production' } }] }],
  ['sessions + env=production', '/v1/query/usage',
    { query: [{ name: 'sessions', filter: { projectID: VF_PROJECT, startTime: START, endTime: END, projectEnvironmentIDOrAlias: 'production' } }] }],
  ['token_usage + env=production', '/v1/query/usage',
    { query: [{ name: 'token_usage', filter: { projectID: VF_PROJECT, startTime: START, endTime: END, projectEnvironmentIDOrAlias: 'production' } }] }],
  ['transcripts top-level resources', '/v1/query/usage',
    { resources: [{ id: VF_PROJECT, type: 'project' }], query: [{ name: 'transcripts', filter: { startTime: START, endTime: END } }] }],
  ['interactions top-level resources', '/v1/query/usage',
    { resources: [{ id: VF_PROJECT, type: 'project' }], query: [{ name: 'interactions', filter: { startTime: START, endTime: END } }] }],
  ['v2 data-shape interactions', '/v2/query/usage',
    { query: [{ name: 'interactions', filter: { projectID: VF_PROJECT, startTime: START, endTime: END } }] }],
  ['interactions no-env baseline', '/v1/query/usage',
    { query: [{ name: 'interactions', filter: { projectID: VF_PROJECT, startTime: START, endTime: END } }] }],
];

(async () => {
  if (!VF_KEY) { console.error('VOICEFLOW_KEY not set'); process.exit(1); }
  console.log('===== VF USAGE SCHEMA PROBE (August 2026) =====');
  for (const [label, path, body] of shapes) {
    try { console.log(`\n[${label}] ${path}\n  ${await post(path, body)}`); }
    catch (e) { console.log(`\n[${label}] ERROR: ${e.message}`); }
    await new Promise(r => setTimeout(r, 400));
  }
  console.log('\n===== DONE =====');
})();
