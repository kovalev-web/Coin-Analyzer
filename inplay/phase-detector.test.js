'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { updatePhases, resetState } = require('./phase-detector');

// ── Helpers ───────────────────────────────────────────────────────────────

function candle(close, volume) {
  return { time: 0, open: close, high: close * 1.01, low: close * 0.99, close, volume, trades: 100 };
}

// Minimal buf5m that passes entry conditions with default config.
//   n = 27 candles: [0..23] baseline vol=100 close=90, [24..26] high vol close rises to 100.
//   rvol[26] = 5000 / mean(buf[6..25]) ≈ 8.47   (2 high-vol candles in baseline)
//   rvol[25] = 5000 / mean(buf[5..24]) ≈ 14.49  (1 high-vol candle in baseline)
//   rvol[24] = 5000 / mean(buf[4..23]) = 50      (0 high-vol candles in baseline)
//   rvol_avg ≈ 24.3 >= 10, rvol_min ≈ 8.47 >= 2
//   delta_price = (100 - 90) / 90 * 100 ≈ 11.1% >= 10
function makeEntryBuf() {
  var buf = [];
  for (var i = 0; i < 24; i++) buf.push(candle(90, 100));
  buf.push(candle(95, 5000));
  buf.push(candle(98, 5000));
  buf.push(candle(100, 5000));
  return buf; // length 27
}

// Same structure but all volumes = 100 → rvol_avg ≈ 1 (no anomaly)
function makeLowRvolBuf() {
  var buf = [];
  for (var i = 0; i < 24; i++) buf.push(candle(90, 100));
  buf.push(candle(95, 100));
  buf.push(candle(98, 100));
  buf.push(candle(100, 100));
  return buf;
}

// High vol but flat price → |delta_price| ≈ 0%
function makeFlatPriceBuf() {
  var buf = [];
  for (var i = 0; i < 24; i++) buf.push(candle(100, 100));
  buf.push(candle(100, 5000));
  buf.push(candle(100, 5000));
  buf.push(candle(100, 5000));
  return buf;
}

// After entry, rvol drops to ~1.5 but price continued 3% in direction → hold by price
function makeHoldByPriceBuf() {
  var buf = [];
  for (var i = 0; i < 24; i++) buf.push(candle(90, 100));
  buf.push(candle(95, 150));
  buf.push(candle(98, 150));
  buf.push(candle(103, 150)); // delta_price_15m from 90 → 103 ≈ 14.4% (still >= 2% hold)
  return buf;
}

// Cooling trigger: rvol_avg < 3 AND |delta_price| < 1%
function makeCoolingBuf() {
  var buf = [];
  for (var i = 0; i < 27; i++) buf.push(candle(100, 100)); // rvol=1, delta=0
  return buf;
}

// buf too short to compute signals (< 23 candles needed)
function makeShortBuf() {
  var buf = [];
  for (var i = 0; i < 10; i++) buf.push(candle(100, 100));
  return buf;
}

function getBuffer(sym, tf) {
  if (tf !== '5m') return [];
  return _buffers[sym] || [];
}

function getNoMicro() { return { cvd_z: null }; }
function getMicroAligned()    { return { cvd_z: 1.5 };  } // positive, same sign as +delta
function getMicroMisaligned() { return { cvd_z: -1.5 }; } // negative, opposite sign

var _buffers = {};

// ── Tests ─────────────────────────────────────────────────────────────────

// Baseline config with CVD disabled (simulating backtest mode)
const cfg = require('./config.json');
const noCvdEntry = Object.assign({}, cfg.phase_detector.entry, { cvd_alignment: false });
const noCvdPd = Object.assign({}, cfg.phase_detector, { entry: noCvdEntry });

test('not_in_phase → active when entry conditions met (CVD disabled)', function () {
  resetState();
  _buffers['AAA'] = makeEntryBuf();
  var r = updatePhases(['AAA'], getBuffer, getNoMicro, null, 1000, noCvdPd);
  assert.equal(r.transitions.length, 1);
  assert.equal(r.transitions[0].from, 'not_in_phase');
  assert.equal(r.transitions[0].to, 'active');
  assert.equal(r.transitions[0].direction, 1); // LONG (price went up)
  assert.equal(r.phases.length, 1);
  assert.equal(r.phases[0].symbol, 'AAA');
  assert.equal(r.phases[0].status, 'active');
});

test('stays not_in_phase when rvol_avg too low', function () {
  resetState();
  _buffers['BBB'] = makeLowRvolBuf();
  var r = updatePhases(['BBB'], getBuffer, getNoMicro, null, 1000, noCvdPd);
  assert.equal(r.transitions.length, 0);
  assert.equal(r.phases.length, 0);
});

test('stays not_in_phase when |delta_price| too small', function () {
  resetState();
  _buffers['CCC'] = makeFlatPriceBuf();
  var r = updatePhases(['CCC'], getBuffer, getNoMicro, null, 1000, noCvdPd);
  assert.equal(r.transitions.length, 0);
  assert.equal(r.phases.length, 0);
});

test('stays not_in_phase when CVD alignment required but missing', function () {
  resetState();
  _buffers['DDD'] = makeEntryBuf();
  // cvd_alignment: true, cvd_z = null → entry blocked
  var r = updatePhases(['DDD'], getBuffer, getNoMicro, null, 1000, cfg.phase_detector);
  assert.equal(r.transitions.length, 0);
});

test('stays not_in_phase when CVD misaligned', function () {
  resetState();
  _buffers['EEE'] = makeEntryBuf();
  var r = updatePhases(['EEE'], getBuffer, getMicroMisaligned, null, 1000, cfg.phase_detector);
  assert.equal(r.transitions.length, 0);
});

test('enters active when CVD aligned', function () {
  resetState();
  _buffers['FFF'] = makeEntryBuf();
  var r = updatePhases(['FFF'], getBuffer, getMicroAligned, null, 1000, cfg.phase_detector);
  assert.equal(r.transitions.length, 1);
  assert.equal(r.transitions[0].to, 'active');
});

test('active → stays active when hold conditions met', function () {
  resetState();
  _buffers['GGG'] = makeEntryBuf();
  // Tick 1: enter phase
  updatePhases(['GGG'], getBuffer, getNoMicro, null, 1000, noCvdPd);
  // Tick 2: same buf (rvol still high → hold)
  var r2 = updatePhases(['GGG'], getBuffer, getNoMicro, null, 6000, noCvdPd);
  assert.equal(r2.transitions.length, 0); // no transition
  assert.equal(r2.phases[0].status, 'active');
});

test('active → stays active when price continues (hold by price)', function () {
  resetState();
  _buffers['HHH'] = makeEntryBuf();
  updatePhases(['HHH'], getBuffer, getNoMicro, null, 1000, noCvdPd);
  _buffers['HHH'] = makeHoldByPriceBuf();
  var r2 = updatePhases(['HHH'], getBuffer, getNoMicro, null, 6000, noCvdPd);
  assert.equal(r2.phases[0].status, 'active');
});

test('active → cooling when cooling trigger fires', function () {
  resetState();
  _buffers['III'] = makeEntryBuf();
  updatePhases(['III'], getBuffer, getNoMicro, null, 1000, noCvdPd);
  _buffers['III'] = makeCoolingBuf();
  var r2 = updatePhases(['III'], getBuffer, getNoMicro, null, 6000, noCvdPd);
  assert.equal(r2.transitions.length, 1);
  assert.equal(r2.transitions[0].from, 'active');
  assert.equal(r2.transitions[0].to, 'cooling');
  assert.equal(r2.phases[0].status, 'cooling');
});

test('cooling → active (revival) when entry conditions met again', function () {
  resetState();
  _buffers['JJJ'] = makeEntryBuf();
  updatePhases(['JJJ'], getBuffer, getNoMicro, null, 1000, noCvdPd);  // enter
  _buffers['JJJ'] = makeCoolingBuf();
  updatePhases(['JJJ'], getBuffer, getNoMicro, null, 6000, noCvdPd);  // → cooling
  _buffers['JJJ'] = makeEntryBuf();
  var r3 = updatePhases(['JJJ'], getBuffer, getNoMicro, null, 11000, noCvdPd); // revival
  assert.equal(r3.transitions.length, 1);
  assert.equal(r3.transitions[0].from, 'cooling');
  assert.equal(r3.transitions[0].to, 'active');
  assert.equal(r3.transitions[0].revival, true);
  assert.equal(r3.phases[0].revivals_count, 1);
});

test('cooling → not_in_phase after timeout', function () {
  resetState();
  _buffers['KKK'] = makeEntryBuf();
  updatePhases(['KKK'], getBuffer, getNoMicro, null, 1000, noCvdPd);
  _buffers['KKK'] = makeCoolingBuf();
  updatePhases(['KKK'], getBuffer, getNoMicro, null, 6000, noCvdPd); // → cooling at t=6000
  var timeoutMs = noCvdPd.cooling_timeout_minutes * 60 * 1000;
  var r3 = updatePhases(['KKK'], getBuffer, getNoMicro, null, 6000 + timeoutMs + 1, noCvdPd);
  assert.equal(r3.transitions.length, 1);
  assert.equal(r3.transitions[0].from, 'cooling');
  assert.equal(r3.transitions[0].to, 'not_in_phase');
  assert.equal(r3.transitions[0].reason, 'timeout');
  assert.equal(r3.phases.length, 0);
});

test('not_in_phase when buffer too short', function () {
  resetState();
  _buffers['LLL'] = makeShortBuf();
  var r = updatePhases(['LLL'], getBuffer, getNoMicro, null, 1000, noCvdPd);
  assert.equal(r.phases.length, 0);
  assert.equal(r.transitions.length, 0);
});

test('direction = -1 (SHORT) when price dropped', function () {
  resetState();
  var buf = [];
  for (var i = 0; i < 24; i++) buf.push(candle(100, 100));
  buf.push(candle(95, 5000));
  buf.push(candle(92, 5000));
  buf.push(candle(89, 5000)); // delta_price = (89-100)/100*100 = -11%
  _buffers['MMM'] = buf;
  var r = updatePhases(['MMM'], getBuffer, getNoMicro, null, 1000, noCvdPd);
  assert.equal(r.transitions[0].direction, -1);
});

test('phase_start_time set at entry, not reset on hold', function () {
  resetState();
  _buffers['NNN'] = makeEntryBuf();
  var r1 = updatePhases(['NNN'], getBuffer, getNoMicro, null, 1000, noCvdPd);
  assert.equal(r1.phases[0].phase_start_time, 1000);
  var r2 = updatePhases(['NNN'], getBuffer, getNoMicro, null, 6000, noCvdPd);
  assert.equal(r2.phases[0].phase_start_time, 1000); // unchanged
});
