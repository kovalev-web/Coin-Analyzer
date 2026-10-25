'use strict';

// Encrypted store for Binance trading keys, one slot per environment
// (testnet / mainnet). AES-256-GCM; the master key lives in the trader config
// (/etc/questtick-trader/config.json, 600), never next to the data file.

var fs = require('fs');
var crypto = require('crypto');

var ENVS = { testnet: true, mainnet: true };

function mask(apiKey) {
  if (!apiKey) return null;
  return apiKey.slice(0, 4) + '…' + apiKey.slice(-4);
}

function createStore(file, masterKeyHex) {
  var key = Buffer.from(String(masterKeyHex || ''), 'hex');
  if (key.length !== 32) throw new Error('masterKey must be 64 hex chars (32 bytes)');

  function load() {
    var raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return {};
      throw e;
    }
    var o = JSON.parse(raw);
    var d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(o.iv, 'hex'));
    d.setAuthTag(Buffer.from(o.tag, 'hex'));
    var plain = Buffer.concat([d.update(Buffer.from(o.data, 'hex')), d.final()]);
    return JSON.parse(plain.toString('utf8'));
  }

  function save(obj) {
    var iv = crypto.randomBytes(12);
    var c = crypto.createCipheriv('aes-256-gcm', key, iv);
    var data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    var out = JSON.stringify({ v: 1, iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), data: data.toString('hex') });
    var tmp = file + '.tmp';
    fs.writeFileSync(tmp, out, { mode: 0o600 });
    fs.renameSync(tmp, file); // atomic: never a half-written key file
  }

  function check(env) {
    if (!ENVS[env]) throw new Error('env must be testnet or mainnet');
  }

  return {
    get: function (env) { check(env); return load()[env] || null; },
    set: function (env, creds) {
      check(env);
      var all = load();
      all[env] = {
        apiKey: creds.apiKey, apiSecret: creds.apiSecret,
        savedAt: new Date().toISOString(), checks: creds.checks || null,
      };
      save(all);
      return all[env];
    },
    remove: function (env) {
      check(env);
      var all = load();
      delete all[env];
      save(all);
    },
    // Other secrets kept in the same encrypted file (e.g. the 2FA seed)
    getSecure: function (name) { return load()['_' + name] || null; },
    setSecure: function (name, value) {
      var all = load();
      if (value == null) delete all['_' + name]; else all['_' + name] = value;
      save(all);
    },
    // Safe to show: no secret, key masked
    describe: function () {
      var all = load();
      var out = {};
      Object.keys(ENVS).forEach(function (env) {
        var c = all[env];
        out[env] = c ? { apiKey: mask(c.apiKey), savedAt: c.savedAt, checks: c.checks } : null;
      });
      return out;
    },
  };
}

module.exports = { createStore, mask };
