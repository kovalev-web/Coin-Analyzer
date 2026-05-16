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
  } catch { return []; }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });
  }

  const { name, symbol, change24h, volume, price, natr } = req.body;
  if (!name || !symbol) {
    return res.status(400).json({ error: 'Missing required fields: name, symbol' });
  }

  const natrLine = natr != null ? '\n- Волатильность NATR 5м: ' + natr + '%' : '';
  const news = await fetchNews(name);
  const newsBlock = news.length ? '\nПоследние новости:\n- ' + news.join('\n- ') + '\n' : '';
  const prompt = 'Ты криптоаналитик. Проанализируй монету ' + name + ' (' + symbol + ').\n\n' +
    'Данные:\n' +
    '- Рост за 24ч: ' + change24h + '%\n' +
    '- Объём за 24ч: $' + volume + '\n' +
    '- Цена: $' + price + natrLine + newsBlock + '\n' +
    'Оцени вероятность продолжения роста. Определи возможный катализатор памп-движения.\n\n' +
    'Ответь ТОЛЬКО валидным JSON без markdown и комментариев:\n' +
    '{"signal":"bullish","catalyst":"...по-русски...","reasoning":"...по-русски...","news_summary":"...по-русски..."}\n\n' +
    'signal = bullish|neutral|caution\n' +
    'news_summary — краткая сводка новостей (1-2 предложения). Если новостей нет, оставь пустой строкой.';

  try {
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
      console.error('Gemini API error:', response.status, errText);
      return res.status(502).json({ error: 'Gemini API returned ' + response.status });
    }

    const data = await response.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    const rawText = parts.map(function(p) { return p.text || ''; }).join('');
    const cleaned = rawText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('No JSON found in Gemini response:', rawText);
      return res.status(502).json({ error: 'Gemini returned no parseable JSON' });
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.error('JSON parse error:', e.message);
      return res.status(502).json({ error: 'Gemini returned invalid JSON' });
    }

    const required = ['signal', 'catalyst', 'reasoning', 'news_summary'];
    for (const field of required) {
      if (!(field in parsed)) {
        console.error('Missing field:', field);
        return res.status(502).json({ error: 'Missing field: ' + field });
      }
    }

    res.json(parsed);
  } catch (err) {
    console.error('Request error:', err.message);
    res.status(502).json({ error: 'Network error calling Gemini API' });
  }
};
