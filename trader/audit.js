'use strict';

// Append-only JSONL log of every trading action and its outcome.
// Never contains keys or signatures: callers pass request bodies, not URLs.

var fs = require('fs');
var path = require('path');

function createAudit(dataDir) {
  var file = path.join(dataDir, 'audit.jsonl');
  return function audit(action, request, outcome) {
    var line = JSON.stringify({
      ts: new Date().toISOString(), action: action, request: request,
      ok: !outcome || !outcome.error, result: outcome && outcome.result, error: outcome && outcome.error,
    }) + '\n';
    try { fs.appendFileSync(file, line, { mode: 0o600 }); } catch (e) {
      console.error('[Audit] write failed:', e.message);
    }
  };
}

module.exports = { createAudit };
