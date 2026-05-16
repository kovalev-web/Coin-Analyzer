const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-2.5-flash';

async function fetchNews(query) {
  try {
    const url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(query + ' crypto') + '&hl=en-US&gl=US&ceid=US:en';
    const res = await fetch(url);
    if (!res.ok) return [];
    const xml = await res.text();
    const titles = [];
    const regex = /<title>(.*?)<\/title>/gi;
    let match, first = true;
    while ((match = regex.exec(xml)) !== null) {
      if (first) { first = false; continue; }
      const t = match[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      if (titles.length < 5) titles.push(t);
    }
    return titles;
  } catch (e) { return []; }
}

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
    return send(res, 200, { ok: true, message: 'API is running', env: !!GEMINI_API_KEY });
  }

  if (req.method !== 'POST') {
    return send(res, 405, { error: 'Method not allowed' });
  }

  try {
    if (!GEMINI_API_KEY) {
      return send(res, 500, { error: 'GEMINI_API_KEY not configured' });
    }

    const body = req.body || {};
    const { name, symbol, change24h, volume, price, natr } = body;

    if (!name || !symbol) {
      return send(res, 400, { error: 'Missing required fields: name, symbol' });
    }

    const natrLine = natr != null ? '\n- Волатильность NATR 5м: ' + natr + '%' : '';
    const news = await fetchNews(name);
    const newsBlock = news.length ? '\nПоследние новости:\n- ' + news.join('\n- ') + '\n' : '';
    const prompt = 'Ты криптоаналитик. Проанализируй монету ' + name + ' (' + symbol + ').\n\nДанные:\n- Рост за 24ч: ' + change24h + '%\n- Объём за 24ч: $' + volume + '\n- Цена: $' + price + natrLine + newsBlock + '\nОцени вероятность продолжения роста. Определи возможный катализатор памп-движения.\n\nОтветь ТОЛЬКО валидным JSON без markdown и комментариев:\n{"signal":"bullish","catalyst":"...по-русски...","reasoning":"...по-русски...","news_summary":"...по-русски..."}\n\nsignal = bullish|neutral|caution\nnews_summary — краткая сводка новостей (1-2 предложения). Если новостей нет, оставь пустой строкой.';

    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + GEMINI_API_KEY;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3 },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return send(res, 502, { error: 'Gemini API returned ' + response.status, details: errText.slice(0, 200) });
    }

    const raw = await response.json();
    const parts = raw.candidates?.[0]?.content?.parts || [];
    const rawText = parts.map(function(p) { return p.text || ''; }).join('');
    const cleaned = rawText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return send(res, 502, { error: 'Gemini returned no parseable JSON', raw: rawText.slice(0, 200) });
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch (e) {
      return send(res, 502, { error: 'Gemini returned invalid JSON', raw: rawText.slice(0, 200) });
    }

    const required = ['signal', 'catalyst', 'reasoning', 'news_summary'];
    for (const field of required) {
      if (!(field in parsed)) {
        return send(res, 502, { error: 'Missing field: ' + field, raw: rawText.slice(0, 200) });
      }
    }

    send(res, 200, parsed);
  } catch (err) {
    return send(res, 502, { error: 'Internal error', message: err.message, stack: (err.stack || '').slice(0, 300) });
  }
};
