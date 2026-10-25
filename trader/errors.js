'use strict';

// Binance error → short message for the UI. Unknown codes keep Binance's text.

var MESSAGES = {
  '-2019': 'Not enough margin for this order',
  '-2022': 'Reduce-only order rejected: it would increase or open a position',
  '-2021': 'Stop price would trigger immediately',
  '-1111': 'Price or quantity has too many decimals for this symbol',
  '-4164': 'Order value is below the exchange minimum',
  '-4003': 'Quantity must be greater than 0',
  '-4061': 'Position side does not match the account position mode',
  '-4131': 'Price is too far from the market price',
  '-5022': 'Post-only order would execute immediately and was rejected',
  '-4120': 'Conditional orders must go through the algo order endpoint',
  '-1125': 'User data stream key expired',
  '-2011': 'Order not found or already closed',
  '-4509': 'Close-position stop/take-profit needs an open position',
};

function describeError(e) {
  if (!e) return { message: 'Unknown error' };
  var out = { message: e.message, binanceCode: e.code, status: e.status };
  if (e.code != null && MESSAGES[String(e.code)]) out.message = MESSAGES[String(e.code)];
  if (e.status === 418 || e.status === 429) {
    out.message = (e.status === 418 ? 'Binance has temporarily banned this server IP' : 'Binance rate limit hit')
      + (e.retryAfter ? ' — retry in ' + e.retryAfter + 's' : '');
  }
  if (e.code === -2015 || e.code === -2014) {
    // Also what the broker risk manager block looks like from the API side
    out.message = 'API key rejected: check key, IP whitelist and trade permission, or trading is paused by the broker risk manager (resumes 00:00 UTC)';
  }
  if (e.noResponse) out.message = 'No response from Binance: ' + e.message;
  return out;
}

module.exports = { describeError };
