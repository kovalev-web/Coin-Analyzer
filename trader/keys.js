'use strict';

// Checks a trading key against Binance before it is saved:
//   - futures access works and the account can trade (/fapi/v2/account)
//   - one-way position mode (hedge mode isn't supported by the terminal)
//   - live keys only: withdrawals must be off and the key must be IP-restricted
//     (/sapi/v1/account/apiRestrictions on the spot API); if that can't be
//     read, the key is rejected rather than saved unverified

var { createClient, sign, buildQuery } = require('./binance');

var SPOT_API = 'https://api.binance.com';

async function validateKeys(opts) {
  var fetchImpl = opts.fetch || fetch;
  var client = createClient({ rest: opts.rest, apiKey: opts.apiKey, apiSecret: opts.apiSecret, fetch: fetchImpl });
  var checks = { futures: false, canTrade: false, positionMode: null, withdrawals: null, ipRestrict: null };

  await client.syncTime();
  var acc = await client.request('GET', '/fapi/v2/account');
  checks.futures = true;
  checks.canTrade = acc.canTrade !== false;
  if (!checks.canTrade) return { ok: false, error: 'This key cannot trade futures. Enable trade access for the key.', checks: checks };

  var mode = await client.request('GET', '/fapi/v1/positionSide/dual');
  checks.positionMode = mode.dualSidePosition ? 'hedge' : 'oneway';

  if (opts.env === 'mainnet') {
    var r = await restrictions(opts, fetchImpl, client.getTimeOffset());
    if (!r) {
      // Live keys are never saved unverified: an unrestricted trading key works from anywhere
      return { ok: false, error: 'Could not verify the key restrictions with Binance (withdrawals, IP whitelist). Try again in a minute.', checks: checks };
    } else {
      checks.withdrawals = !!r.enableWithdrawals;
      checks.ipRestrict = !!r.ipRestrict;
      if (checks.withdrawals) return { ok: false, error: 'This key can withdraw funds. Create a key without withdrawal permission.', checks: checks };
      if (!checks.ipRestrict) return { ok: false, error: 'Restrict this key to the trading server IP before saving it.', checks: checks };
    }
  }
  return { ok: true, checks: checks };
}

async function restrictions(opts, fetchImpl, timeOffset) {
  try {
    var q = buildQuery({ recvWindow: 5000, timestamp: Date.now() + (timeOffset || 0) });
    var url = (opts.spotApi || SPOT_API) + '/sapi/v1/account/apiRestrictions?' + q + '&signature=' + sign(q, opts.apiSecret);
    var res = await fetchImpl(url, { headers: { 'X-MBX-APIKEY': opts.apiKey }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

module.exports = { validateKeys };
