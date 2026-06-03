// Vercel Serverless Function — Voiceflow proxy
// Deploy env vars: VOICEFLOW_KEY
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = process.env.VOICEFLOW_KEY || 'VF.DM.69ebdbdd003c5c7a49123a84.tpJNpT29BPPKNO1V';

  const { path, ...params } = req.query;
  if (!path) return res.status(400).json({ error: 'Missing path param' });

  const url = new URL(`https://api.voiceflow.com/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const upstream = await fetch(url.toString(), {
    headers: {
      Authorization: key,
      'Content-Type': 'application/json',
    },
  });

  const body = await upstream.text();
  res.status(upstream.status)
    .setHeader('Content-Type', 'application/json')
    .send(body);
}
