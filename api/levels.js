const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(cmd) {
  if (!REDIS_URL || !REDIS_TOKEN) throw new Error('Redis not configured');
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  return res.json();
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { action, code, levels } = req.body || {};

  if (!code || typeof code !== 'string' || !/^[a-zA-Z0-9_\-]{2,40}$/.test(code)) {
    return res.status(400).json({ error: 'Invalid code' });
  }

  const key = 'levels:' + code.toLowerCase();

  try {
    if (action === 'get') {
      const r = await redis(['GET', key]);
      return res.json({ levels: r.result ? JSON.parse(r.result) : {} });
    }
    if (action === 'save') {
      await redis(['SET', key, JSON.stringify(levels || {})]);
      return res.json({ ok: true });
    }
    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};
