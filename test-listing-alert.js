// Test script: verify new-listing Telegram alert delivery
// Usage on VPS: node test-listing-alert.js
// Usage with custom symbol: node test-listing-alert.js XYZUSDT

const fs = require('fs');
const path = require('path');

// Load .env (same logic as server-vps.js)
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').forEach(function (line) {
    var m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  });
} catch (e) {}

var TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
var CHAT_ID = process.env.INPLAY_ALERT_CHAT_ID;
var APP_URL = (process.env.APP_URL || 'https://coin-analyzer.vercel.app').replace(/\/$/, '');

if (!TOKEN)   { console.error('❌  TELEGRAM_BOT_TOKEN not set'); process.exit(1); }
if (!CHAT_ID) { console.error('❌  INPLAY_ALERT_CHAT_ID not set'); process.exit(1); }

var sym  = (process.argv[2] || 'TESTCOINUSDT').toUpperCase();
var coin = sym.replace(/USDT$/, '');

var body = {
  chat_id:      CHAT_ID,
  text:         '🆕 Новый листинг!\n<b>' + sym + '</b>\n\n<i>— тест доставки ✓</i>',
  parse_mode:   'HTML',
  reply_markup: {
    inline_keyboard: [[{ text: '📈 Открыть график', url: APP_URL + '/?sym=' + coin }]]
  }
};

console.log('Sending test listing alert...');
console.log('  symbol :', sym);
console.log('  chat_id:', CHAT_ID);
console.log('  app_url:', APP_URL + '/?sym=' + coin);

fetch('https://api.telegram.org/bot' + TOKEN + '/sendMessage', {
  method:  'POST',
  headers: { 'Content-Type': 'application/json' },
  body:    JSON.stringify(body),
})
  .then(function (r) { return r.json(); })
  .then(function (d) {
    if (d.ok) {
      console.log('✅  Sent! message_id:', d.result.message_id);
    } else {
      console.error('❌  Telegram error:', d.description);
    }
  })
  .catch(function (e) {
    console.error('❌  Network error:', e.message);
  });
