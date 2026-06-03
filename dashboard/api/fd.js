// Vercel Serverless Function — Freshdesk proxy
// Keeps credentials server-side and handles CORS for the browser dashboard.
// Deploy env vars: FRESHDESK_KEY, FRESHDESK_DOMAIN
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = process.env.FRESHDESK_KEY || 'yVYzvzk27Er2dUpUCA9';
  const domain = process.env.FRESHDESK_DOMAIN || 'universaltennis';

  const { path, ...params } = req.query;
  if (!path) return res.status(400).json({ error: 'Missing path param' });

  const url = new URL(`https://${domain}.freshdesk.com/api/v2/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const upstream = await fetch(url.toString(), {
    headers: {
      Authorization: `Basic ${Buffer.from(`${key}:X`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
  });

  const body = await upstream.text();
  res.status(upstream.status)
    .setHeader('Content-Type', 'application/json')
    .send(body);
}
