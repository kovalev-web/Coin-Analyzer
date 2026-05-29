const crypto = require('crypto');

const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PROXY_SECRET = process.env.PROXY_SECRET;

function send(res, code, data) {
  res.setHeader('Content-Type', 'application/json');
  return res.status(code).json(data);
}

function binanceSign(queryString) {
  return crypto.createHmac('sha256', BINANCE_API_SECRET).update(queryString).digest('hex');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });

  const { service, payload, user_code } = req.body || {};

  if (!PROXY_SECRET || user_code !== PROXY_SECRET) {
    return send(res, 401, { error: 'Unauthorized' });
  }

  try {
    // ── Binance Futures ──────────────────────────────────────────────────────
    if (service === 'binance') {
      if (!BINANCE_API_KEY || !BINANCE_API_SECRET) {
        return send(res, 500, { error: 'Binance keys not configured', hasKey: !!BINANCE_API_KEY, hasSecret: !!BINANCE_API_SECRET, binanceVars: Object.keys(process.env).filter(function(k){ return k.includes('BINANCE'); }) });
      }
      const { symbol, startTime, endTime, limit } = payload || {};
      if (!symbol) return send(res, 400, { error: 'symbol required' });

      const params = new URLSearchParams({
        symbol: symbol.toUpperCase(),
        timestamp: String(Date.now()),
        limit: String(limit || 1000),
      });
      if (startTime) params.set('startTime', String(startTime));
      if (endTime) params.set('endTime', String(endTime));

      const qs = params.toString();
      const sig = binanceSign(qs);
      const url = 'https://fapi.binance.com/fapi/v1/userTrades?' + qs + '&signature=' + sig;

      const r = await fetch(url, { headers: { 'X-MBX-APIKEY': BINANCE_API_KEY } });
      const data = await r.json();
      if (!r.ok) return send(res, 502, { error: data.msg || 'Binance error', code: data.code });
      return send(res, 200, { trades: data });
    }

    // ── Gemini ───────────────────────────────────────────────────────────────
    if (service === 'gemini') {
      if (!GEMINI_API_KEY) return send(res, 500, { error: 'Gemini key not configured' });
      const { prompt } = payload || {};
      if (!prompt) return send(res, 400, { error: 'prompt required' });

      const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + GEMINI_API_KEY;
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      });
      const data = await r.json();
      if (!r.ok) return send(res, 502, { error: 'Gemini error', details: data });
      const text = (data.candidates && data.candidates[0] && data.candidates[0].content &&
        data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
        data.candidates[0].content.parts[0].text) || '';
      return send(res, 200, { text });
    }

    return send(res, 400, { error: 'Unknown service: ' + service });
  } catch (e) {
    return send(res, 500, { error: e.message });
  }
};
