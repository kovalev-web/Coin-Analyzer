const { analyzeCoin } = require('../shared/analyze');

function send(res, code, data) {
  res.setHeader('Content-Type', 'application/json');
  return res.status(code).json(data);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    return send(res, 200, { ok: true, message: 'API is running' });
  }

  if (req.method !== 'POST') {
    return send(res, 405, { error: 'Method not allowed' });
  }

  const body = req.body || {};
  const { name, symbol, change24h, volume, price, natr } = body;

  if (!name || !symbol) {
    return send(res, 400, { error: 'Missing required fields: name, symbol' });
  }

  try {
    const result = await analyzeCoin({ name, symbol, change24h, volume, price, natr });
    return send(res, 200, result);
  } catch (err) {
    const msg = err.message || 'Internal error';
    const code = msg.includes('API_KEY') ? 500 : 502;
    return send(res, code, { error: msg });
  }
};
