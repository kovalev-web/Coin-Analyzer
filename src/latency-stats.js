// Formulas behind the terminal's connection indicator (src/latency.js).
// Tests: npm run test:latency

export function percentile(values, p) {
  if (!values.length) return null;
  var v = values.slice().sort(function (a, b) { return a - b; });
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil(p / 100 * v.length) - 1))];
}

// Jitter as the mean change between consecutive pings (RFC 3550 style)
export function jitter(values) {
  if (values.length < 2) return null;
  var sum = 0;
  for (var i = 1; i < values.length; i++) sum += Math.abs(values[i] - values[i - 1]);
  return sum / (values.length - 1);
}

// Server clock − local clock, assuming the reply was stamped halfway through the round trip
export function clockOffset(sentLocal, rtt, serverTime) {
  return serverTime - (sentLocal + rtt / 2);
}

// green / yellow / red from the ping window
export function grade(s) {
  if (!s || s.down) return 'bad';
  if (s.p50 == null) return 'unknown';
  if (s.loss > 0.05 || s.p95 > 400 || s.p50 > 250) return 'bad';
  if (s.loss > 0 || s.p95 > 250 || s.p50 > 150) return 'warn';
  return 'ok';
}

// Cloudflare edge (airport code from cf-ray) → city. Unknown codes are shown as is.
var EDGE_CITIES = {
  NRT: 'Tokyo', HND: 'Tokyo', KIX: 'Osaka', FUK: 'Fukuoka', ICN: 'Seoul', TPE: 'Taipei',
  HKG: 'Hong Kong', SIN: 'Singapore', SGN: 'Ho Chi Minh City', HAN: 'Hanoi', DAD: 'Da Nang',
  BKK: 'Bangkok', KUL: 'Kuala Lumpur', MNL: 'Manila', CGK: 'Jakarta', BOM: 'Mumbai', DEL: 'Delhi',
  SYD: 'Sydney', DXB: 'Dubai', IST: 'Istanbul',
  FRA: 'Frankfurt', DUS: 'Düsseldorf', MUC: 'Munich', HAM: 'Hamburg', BER: 'Berlin', TXL: 'Berlin',
  AMS: 'Amsterdam', LHR: 'London', CDG: 'Paris', WAW: 'Warsaw', VIE: 'Vienna', ZRH: 'Zurich',
  ARN: 'Stockholm', HEL: 'Helsinki', MAD: 'Madrid', MXP: 'Milan', DME: 'Moscow', SVO: 'Moscow',
  LED: 'St Petersburg', KBP: 'Kyiv', TLL: 'Tallinn', RIX: 'Riga',
  IAD: 'Washington', EWR: 'New York', JFK: 'New York', ORD: 'Chicago', DFW: 'Dallas',
  LAX: 'Los Angeles', SJC: 'San Jose', SEA: 'Seattle', MIA: 'Miami', YYZ: 'Toronto',
};

export function edgeCity(code) {
  if (!code) return null;
  return EDGE_CITIES[code] || code;
}

// ISO country code → English name (built into the browser and Node); falls back to the code
export function countryName(code) {
  if (!code || code === 'XX') return null;
  if (code === 'T1') return 'Tor';
  try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) || code; } catch (e) { return code; }
}
