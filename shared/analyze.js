// Shared Gemini AI analysis logic.
// Both api/analyze.js (Vercel) and server.js (local dev) should import this
// for NEW endpoints. Existing endpoints can be migrated gradually.

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
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const afterDate = twoWeeksAgo.toISOString().split('T')[0];
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
      const dateMatch = /<pubDate>(.*?)<\/pubDate>/i.exec(chunk);
      const pubDate = dateMatch ? new Date(dateMatch[1].trim()) : null;
      if (pubDate && (now - pubDate.getTime()) > TWO_WEEKS_MS) continue;
      const titleMatch = /<title>(.*?)<\/title>/i.exec(chunk);
      if (!titleMatch) continue;
      const title = titleMatch[1]
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      const linkMatch = /<link>(.*?)<\/link>/i.exec(chunk) || /<guid[^>]*>(.*?)<\/guid>/i.exec(chunk);
      const link = linkMatch ? linkMatch[1].trim() : null;
      const sourceMatch = /<source url="([^"]+)"/i.exec(chunk);
      const sourceUrl = sourceMatch ? sourceMatch[1] : '';
      items.push({ title, link, pubDate, score: authorityScore(sourceUrl) });
    }
    if (!items.length) return { titles: [], url: null };
    items.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const ta = a.pubDate ? a.pubDate.getTime() : 0;
      const tb = b.pubDate ? b.pubDate.getTime() : 0;
      return tb - ta;
    });
    return { titles: items.slice(0, 5).map(i => i.title), url: items[0].link || null };
  } catch (e) {
    return { titles: [], url: null };
  }
}

function buildPrompt({ name, symbol, change24h, volume, price, natr, news }) {
  const natrLine = natr != null ? '\n- Волатильность NATR 5м: ' + parseFloat(natr).toFixed(2) + '%' : '';
  const newsBlock = news.length
    ? 'Найденные новости по запросу "' + symbol + ' cryptocurrency":\n- ' + news.join('\n- ')
    : 'Новости не найдены.';

  return 'Ты — криптоаналитик. Анализируй токен с тикером ' + symbol + 'USDT — это бессрочный фьючерс на Binance USDT-M Futures.\n\n' +
    '⚠️ ОБЯЗАТЕЛЬНЫЕ ПРАВИЛА:\n' +
    '1. Это КРИПТО-ТОКЕН, не акция и не ETF. Если найденные новости относятся к акции, компании или другому финансовому инструменту с похожим тикером/названием — они нерелевантны. В news_summary напиши "Релевантных крипто-новостей не найдено."\n' +
    '2. Делистинг с биржи — НЕ bullish-катализатор. Памп перед делистингом — спекулятивный и крайне рискованный.\n' +
    '3. Листинг на Binance или крупной бирже — позитивный катализатор (bullish).\n' +
    '4. Твоя задача — оценить, ПРОДОЛЖИТСЯ ли рост, а не объяснить прошлое движение.\n\n' +
    'Данные монеты:\n' +
    '- Тикер: ' + symbol + 'USDT (Binance Futures perpetual)\n' +
    '- Рост за 24ч: ' + change24h + '%\n' +
    '- Объём за 24ч: $' + volume + natrLine + '\n' +
    '- Цена: $' + price + '\n\n' +
    newsBlock + '\n\n' +
    'Правила для signal:\n' +
    '- bullish — реальный позитивный катализатор, вероятность продолжения роста высокая\n' +
    '- caution — рискованный или манипулятивный катализатор\n' +
    '- neutral — нет чёткого катализатора, движение неопределённое\n\n' +
    'Ответь ТОЛЬКО валидным JSON без markdown и комментариев:\n' +
    '{"signal":"bullish","catalyst":"...по-русски...","news_summary":"...по-русски..."}\n\n' +
    'news_summary — 1-2 предложения о найденных новостях. Если свежих релевантных крипто-новостей нет — "Свежих релевантных новостей не найдено."';
}

async function callGemini(prompt) {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const GEMINI_MODEL = 'gemini-2.5-flash';

  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');

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
    const geminiErrors = {
      429: 'Лимит запросов. Попробуйте через минуту.',
      503: 'Gemini недоступен. Попробуйте позже.',
      500: 'Ошибка Gemini. Попробуйте ещё раз.',
      401: 'Неверный API-ключ.',
      400: 'Некорректный запрос.',
    };
    throw new Error(geminiErrors[response.status] || 'Ошибка Gemini API (код ' + response.status + ')');
  }

  const raw = await response.json();
  const parts = raw.candidates?.[0]?.content?.parts || [];
  const rawText = parts.map(p => p.text || '').join('');
  const cleaned = rawText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Gemini returned no parseable JSON');

  let parsed;
  try { parsed = JSON.parse(jsonMatch[0]); } catch (e) { throw new Error('Gemini returned invalid JSON'); }

  const required = ['signal', 'catalyst', 'news_summary'];
  for (const field of required) {
    if (!(field in parsed)) throw new Error('Missing field: ' + field);
  }

  return parsed;
}

async function analyzeCoin({ name, symbol, change24h, volume, price, natr }) {
  const newsResult = await fetchNews(symbol + ' cryptocurrency coin');
  const prompt = buildPrompt({ name, symbol, change24h, volume, price, natr, news: newsResult.titles });
  const result = await callGemini(prompt);
  result.news_url = newsResult.url || null;
  return result;
}

module.exports = { analyzeCoin, fetchNews, callGemini, buildPrompt };
