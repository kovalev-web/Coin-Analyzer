'use strict';

// Run on VPS: node migrate-redis.js
// Copies Redis data from old code 'dmitrii' → new userId

var OLD_CODE = 'dmitrii';
var NEW_ID   = 'Yvo6BTsNvIZBXkkqTWwWmdNTYGUce4SnF';

var fs = require('fs');
fs.readFileSync('.env', 'utf8').split('\n').forEach(function (line) {
  var m = line.match(/^([^=]+)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim();
});

var REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
var REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(cmd) {
  var res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  return res.json();
}

async function copyKey(from, to) {
  var r = await redis(['GET', from]);
  if (!r.result) { console.log('  SKIP ' + from + ' (empty)'); return; }
  await redis(['SET', to, r.result]);
  console.log('  OK   ' + from + ' → ' + to);
}

async function main() {
  console.log('Migrating: ' + OLD_CODE + ' → ' + NEW_ID + '\n');

  await copyKey('levels:'     + OLD_CODE, 'levels:'     + NEW_ID);
  await copyKey('alerts:'     + OLD_CODE, 'alerts:'     + NEW_ID);
  await copyKey('briefing:'   + OLD_CODE, 'briefing:'   + NEW_ID);
  await copyKey('briefing_tz:' + OLD_CODE, 'briefing_tz:' + NEW_ID);

  // Add new userId to alert_codes set
  var r = await redis(['SADD', 'alert_codes', NEW_ID]);
  console.log('  OK   alert_codes += ' + NEW_ID + ' (added: ' + r.result + ')');

  console.log('\nDone.');
}

main().catch(console.error);
