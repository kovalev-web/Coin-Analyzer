// Vercel serverless proxy for Binance USDT-M futures public endpoints.
// Used by the standalone Grid Scanner page (/grid).
// Only passes through read-only market data — no auth or signed requests.

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    return res.status(200).end();
  }
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { path, ...params } = req.query;

  // Whitelist only public market data paths
  if (!path || !path.startsWith('/fapi/v1/')) {
    return res.status(400).json({ error: 'Invalid path' });
  }

  const allowed = ['/fapi/v1/klines', '/fapi/v1/ticker/24hr', '/fapi/v1/exchangeInfo'];
  const base = path.split('?')[0];
  if (!allowed.includes(base)) {
    return res.status(403).json({ error: 'Path not allowed' });
  }

  const qs = new URLSearchParams(params).toString();
  const url = 'https://fapi.binance.com' + path + (qs ? '?' + qs : '');

  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'questtick/1.0' } });
    const data = await r.json();
    res.setHeader('Cache-Control', 'no-store');
    return res.status(r.status).json(data);
  } catch (e) {
    return res.status(502).json({ error: 'Binance unreachable', detail: e.message });
  }
};
