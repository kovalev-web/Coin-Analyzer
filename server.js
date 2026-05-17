const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.error('ERROR: GEMINI_API_KEY environment variable is not set');
  process.exit(1);
}

// Authority scores for news sources (higher = more authoritative)
const SOURCE_SCORES = {
  'reuters.com': 10, 'bloomberg.com': 10, 'wsj.com': 9, 'ft.com': 9,
  'binance.com': 9, 'coindesk.com': 9, 'theblock.co': 8, 'blockworks.co': 8,
  'cointelegraph.com': 8, 'decrypt.co': 8, 'techcrunch.com': 7,
  'forbes.com': 7, 'cryptonews.com': 6, 'cryptoslate.com': 6,
};

function authorityScore(sourceUrl) {
  if (!sourceUrl) return 1;
  for (const [domain, score] of Object.entries(SOURCE_SCORES)) {
    if (sourceUrl.includes(domain)) return score;
  }
  return 2;
}

async function fetchNews(query) {
  try {
    // Ask Google News only for last 14 days
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const afterDate = twoWeeksAgo.toISOString().split('T')[0]; // YYYY-MM-DD
    const rssUrl = 'https://news.google.com/rss/search?q='
      + encodeURIComponent(query + ' after:' + afterDate)
      + '&hl=en-US&gl=US&ceid=US:en';

    const res = await fetch(rssUrl);
    if (!res.ok) return { titles: [], url: null };
    const xml = await res.text();

    const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const items = [];

    const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
    let m;
    while ((m = itemRegex.exec(xml)) !== null) {
      const chunk = m[1];

      // pubDate — skip if older than 2 weeks
      const dateMatch = /<pubDate>(.*?)<\/pubDate>/i.exec(chunk);
      const pubDate = dateMatch ? new Date(dateMatch[1].trim()) : null;
      if (pubDate && (now - pubDate.getTime()) > TWO_WEEKS_MS) continue;

      // title
      const titleMatch = /<title>(.*?)<\/title>/i.exec(chunk);
      if (!titleMatch) continue;
      const title = titleMatch[1]
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

      // link (Google redirect URL)
      const linkMatch = /<link>(.*?)<\/link>/i.exec(chunk)
        || /<guid[^>]*>(.*?)<\/guid>/i.exec(chunk);
      const link = linkMatch ? linkMatch[1].trim() : null;

      // source URL — used to compute authority score
      const sourceMatch = /<source url="([^"]+)"/i.exec(chunk);
      const sourceUrl = sourceMatch ? sourceMatch[1] : '';

      items.push({ title, link, pubDate, score: authorityScore(sourceUrl) });
    }

    if (!items.length) return { titles: [], url: null };

    // Sort: authority desc, then freshness desc
    items.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const ta = a.pubDate ? a.pubDate.getTime() : 0;
      const tb = b.pubDate ? b.pubDate.getTime() : 0;
      return tb - ta;
    });

    return {
      titles: items.slice(0, 5).map(i => i.title),
      url: items[0].link || null,
    };
  } catch (e) {
    console.error('News fetch error:', e.message);
    return { titles: [], url: null };
  }
}

app.post('/api/analyze', async (req, res) => {
  const { name, symbol, change24h, volume, price, natr } = req.body;

  if (!name || !symbol) {
    return res.status(400).json({ error: 'Missing required fields: name, symbol' });
  }

  const natrLine = natr != null ? '\n- Волатильность NATR 5м: ' + natr.toFixed(2) + '%' : '';
  // Search specifically for the crypto token, not stocks or other assets
  const newsResult = await fetchNews(symbol + ' cryptocurrency coin');
  const newsUrl = newsResult.url;
  const news = newsResult.titles;
  const newsBlock = news.length
    ? 'Найденные новости по запросу "' + symbol + ' cryptocurrency":\n- ' + news.join('\n- ')
    : 'Новости не найдены.';

  const prompt =
    'Ты — криптоаналитик. Анализируй токен с тикером ' + symbol + 'USDT — это бессрочный фьючерс на Binance USDT-M Futures.\n\n' +

    '⚠️ ОБЯЗАТЕЛЬНЫЕ ПРАВИЛА:\n' +
    '1. Это КРИПТО-ТОКЕН, не акция и не ETF. Если найденные новости относятся к акции, компании или другому финансовому инструменту с похожим тикером/названием — они нерелевантны. В news_summary напиши "Релевантных крипто-новостей не найдено."\n' +
    '2. Делистинг с биржи — НЕ bullish-катализатор. Памп перед делистингом — спекулятивный и крайне рискованный. Если единственная причина роста — делистинг: signal = caution.\n' +
    '3. Листинг на Binance или крупной бирже — позитивный катализатор (bullish).\n' +
    '4. Твоя задача — оценить, ПРОДОЛЖИТСЯ ли рост, а не объяснить прошлое движение.\n\n' +

    'Данные монеты:\n' +
    '- Тикер: ' + symbol + 'USDT (Binance Futures perpetual)\n' +
    '- Рост за 24ч: ' + change24h + '%\n' +
    '- Объём за 24ч: $' + volume + natrLine + '\n' +
    '- Цена: $' + price + '\n\n' +

    newsBlock + '\n\n' +

    'Правила для signal:\n' +
    '- bullish — реальный позитивный катализатор (новый листинг, партнёрство, апгрейд протокола, рост экосистемы), вероятность продолжения роста высокая\n' +
    '- caution — рискованный или манипулятивный катализатор (делистинг, памп без причины, перекупленность)\n' +
    '- neutral — нет чёткого катализатора, движение неопределённое\n\n' +

    '⚠️ ЗАПРЕТЫ:\n' +
    '- Новости старше 2 недель — игнорируй полностью. Нас интересует только то, что происходит сейчас.\n' +
    '- Не выдумывай катализатор. Если свежих релевантных новостей нет — честно укажи это в catalyst и поставь signal = neutral или caution.\n\n' +

    'Ответь ТОЛЬКО валидным JSON без markdown и комментариев:\n' +
    '{"signal":"bullish","catalyst":"...по-русски...","news_summary":"...по-русски..."}\n\n' +
    'news_summary — 1-2 предложения о найденных новостях. Если свежих релевантных крипто-новостей нет — "Свежих релевантных новостей не найдено."';

  try {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + GEMINI_API_KEY;
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
      const geminiErrors = {
        429: 'Лимит запросов. Попробуйте через минуту.',
        503: 'Gemini недоступен. Попробуйте позже.',
        500: 'Ошибка Gemini. Попробуйте ещё раз.',
        401: 'Неверный API-ключ.',
        400: 'Некорректный запрос.',
      };
      const msg = geminiErrors[response.status] || 'Ошибка Gemini API (код ' + response.status + ').';
      return res.status(502).json({ error: msg });
    }

    const data = await response.json();

    const parts = data.candidates?.[0]?.content?.parts || [];
    const rawText = parts.map(function(p) { return p.text || ''; }).join('');

    const cleaned = rawText
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim();

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

    const required = ['signal', 'catalyst', 'news_summary'];
    for (const field of required) {
      if (!(field in parsed)) {
        console.error('Missing field:', field);
        return res.status(502).json({ error: 'Missing field: ' + field });
      }
    }

    parsed.news_url = newsUrl || null;
    res.json(parsed);
  } catch (err) {
    console.error('Request error:', err.message);
    res.status(502).json({ error: 'Network error calling Gemini API' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('Pump Analyzer running at http://localhost:' + PORT);
});
