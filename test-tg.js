'use strict';
// Запуск: node test-tg.js
// Проверяет доставку Telegram-алертов

var token  = process.env.TELEGRAM_BOT_TOKEN;
var chatId = process.env.INPLAY_ALERT_CHAT_ID;

if (!token || !chatId) {
  console.error('Нужны TELEGRAM_BOT_TOKEN и INPLAY_ALERT_CHAT_ID');
  process.exit(1);
}

var text = '🚨 Inplay Phase [TEST]\n<b>BTC</b> — 🟢 LONG ↑\nRVOL: 9.2x | Δp15m: +10.50% | CVD_z: 1.83\n24h Vol: $48.2B';

fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML' }),
})
  .then(function (r) { return r.json(); })
  .then(function (d) {
    if (d.ok) console.log('✓ Алерт отправлен');
    else console.error('✗ Ошибка:', JSON.stringify(d));
  })
  .catch(function (e) { console.error('✗ fetch failed:', e.message); });
