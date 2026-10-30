// Short labels of algorithms found in the tape (server algos/): the briefing
// list badge, the toast, the chart card's venue
export var ALGO_VENUES = { bnf: 'Binance F', bns: 'Binance S', byp: 'Bybit P', bys: 'Bybit S', okp: 'OKX P', oks: 'OKX S', hlp: 'Hyperliquid P', upb: 'Upbit KRW' };

// "C · покупка · Bybit P"
export function algoShort(a) {
  return (a.kind === 'pressure' ? 'C' : 'P') + ' · ' + (a.buy ? 'покупка' : 'продажа') + ' · ' + (ALGO_VENUES[a.venue] || a.venue);
}
