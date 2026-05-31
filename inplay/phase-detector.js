'use strict';

var cfg = require('./config.json');
var tb  = require('./trade-buffers');
var ms  = require('./microstructure');

// ── Per-symbol state ──────────────────────────────────────────────────────

var _state = {};

function getState(sym) {
  if (!_state[sym]) {
    _state[sym] = {
      status: 'not_in_phase',
      direction: null,
      phase_start_time: null,
      cooling_start_time: null,
      revivals_count: 0,
    };
  }
  return _state[sym];
}

// ── Signal computation ────────────────────────────────────────────────────

// RVOL for candle at index i: buf[i].volume / mean(buf[i-window : i])
function rvolAt(buf, i, window) {
  if (i < window) return null;
  var sum = 0;
  for (var j = i - window; j < i; j++) sum += buf[j].volume;
  var m = sum / window;
  return m === 0 ? null : buf[i].volume / m;
}

// CVD z-score from live trade state — default for production
function defaultGetMicro(sym) {
  var state = tb.getTradeState(sym);
  if (!state) return { cvd_z: null };
  var w = cfg.windows;
  var slope = ms.cvdSlope(state.cvdPoints, w.cvd_slope_window_ms);
  if (slope === null) return { cvd_z: null };
  return { cvd_z: ms.cvdZscore(slope, state.cvdSlopeHist, w.cvd_zscore_window) };
}

function computeSignals(sym, buf5m, getMicroFn, pd) {
  var rvolWindow = cfg.windows.rvol_5m;
  var avgWindow  = pd.entry.rvol_avg_window;
  var n          = buf5m.length;

  if (n < rvolWindow + avgWindow) return null;

  // RVOL for last avgWindow closed 5m candles (rvols[0] = most recent)
  var rvols = [];
  for (var k = 0; k < avgWindow; k++) {
    var r = rvolAt(buf5m, n - 1 - k, rvolWindow);
    if (r === null) return null;
    rvols.push(r);
  }
  var rvol_avg = rvols.reduce(function (s, v) { return s + v; }, 0) / rvols.length;
  var rvol_min = Math.min.apply(null, rvols);

  // Δprice over price_change_window_minutes
  var priceCandles = Math.round(pd.entry.price_change_window_minutes / 5);
  if (n < priceCandles + 1) return null;
  var closeNow  = buf5m[n - 1].close;
  var closeThen = buf5m[n - 1 - priceCandles].close;
  if (closeThen === 0) return null;
  var delta_price = (closeNow - closeThen) / closeThen * 100;

  // CVD z-score
  var micro    = (getMicroFn || defaultGetMicro)(sym);
  var cvd_z    = micro ? (micro.cvd_z !== undefined ? micro.cvd_z : null) : null;
  var cvd_skip = !!(micro && micro.cvd_skip);

  return {
    rvol_avg:    rvol_avg,
    rvol_min:    rvol_min,
    rvol_last:   rvols[0],
    delta_price: delta_price,
    cvd_z:       cvd_z,
    cvd_skip:    cvd_skip,
  };
}

// ── Condition checks ──────────────────────────────────────────────────────

function checkEntry(signals, e) {
  if (signals.rvol_avg < e.rvol_avg_threshold)             return false;
  if (signals.rvol_min < e.rvol_min_threshold)             return false;
  if (Math.abs(signals.delta_price) < e.price_change_threshold_pct) return false;
  // Skip CVD check during warmup period (cvd_skip=true when history < cvd_warmup_minutes)
  if (e.cvd_alignment && !signals.cvd_skip) {
    if (signals.cvd_z === null)                            return false;
    if (Math.abs(signals.cvd_z) < e.cvd_zscore_min)       return false;
    if ((signals.cvd_z > 0) !== (signals.delta_price > 0)) return false;
  }
  return true;
}

function checkHold(signals, direction, h) {
  if (signals.rvol_avg >= h.rvol_avg_threshold)                          return true;
  if (signals.delta_price * direction >= h.price_continues_threshold_pct) return true;
  return false;
}

function hasCvdReversal(signals, direction, h) {
  if (!h.cvd_no_reversal || signals.cvd_z === null) return false;
  return (signals.cvd_z * direction) < h.cvd_reversal_threshold;
}

function checkCoolingTrigger(signals, ct) {
  return signals.rvol_avg < ct.rvol_avg_threshold &&
         Math.abs(signals.delta_price) < ct.price_stagnant_threshold_pct;
}

// ── State machine step for one symbol ────────────────────────────────────
// Returns { result, transitions }

function stepSymbol(sym, buf5m, getMicroFn, now, pd, logFn) {
  var state       = getState(sym);
  var transitions = [];
  var timeoutMs   = pd.cooling_timeout_minutes * 60 * 1000;

  var signals = computeSignals(sym, buf5m, getMicroFn, pd);

  if (!signals) {
    if (state.status !== 'not_in_phase') {
      var prev = state.status;
      state.status           = 'not_in_phase';
      state.direction        = null;
      state.phase_start_time = null;
      state.cooling_start_time = null;
      transitions.push({ symbol: sym, from: prev, to: 'not_in_phase', reason: 'no_data', ts: now });
    }
    return { result: null, transitions: transitions };
  }

  if (state.status === 'not_in_phase') {
    if (checkEntry(signals, pd.entry)) {
      var dir = signals.delta_price > 0 ? 1 : -1;
      state.status             = 'active';
      state.direction          = dir;
      state.phase_start_time   = now;
      state.cooling_start_time = null;
      state.revivals_count     = 0;
      transitions.push({ symbol: sym, from: 'not_in_phase', to: 'active', direction: dir, ts: now });
      if (logFn) logFn('[Phase]', sym, '→ active at', new Date(now).toTimeString().slice(0, 8) + ',', dir > 0 ? 'LONG' : 'SHORT');
    }

  } else if (state.status === 'active') {
    var held = checkHold(signals, state.direction, pd.hold) &&
               !hasCvdReversal(signals, state.direction, pd.hold);
    if (!held && checkCoolingTrigger(signals, pd.cooling_trigger)) {
      state.status             = 'cooling';
      state.cooling_start_time = now;
      transitions.push({ symbol: sym, from: 'active', to: 'cooling', ts: now });
      if (logFn) logFn('[Phase]', sym, '→ cooling');
    }
    // held OR transitional → stay active

  } else if (state.status === 'cooling') {
    if (checkEntry(signals, pd.entry)) {
      state.status             = 'active';
      state.cooling_start_time = null;
      state.revivals_count++;
      transitions.push({ symbol: sym, from: 'cooling', to: 'active', direction: state.direction, revival: true, ts: now });
      if (logFn) logFn('[Phase]', sym, '→ active (revival #' + state.revivals_count + ')');
    } else if (now - state.cooling_start_time > timeoutMs) {
      state.status             = 'not_in_phase';
      state.direction          = null;
      state.phase_start_time   = null;
      state.cooling_start_time = null;
      transitions.push({ symbol: sym, from: 'cooling', to: 'not_in_phase', reason: 'timeout', ts: now });
      if (logFn) logFn('[Phase]', sym, '→ not_in_phase (timeout)');
    }
  }

  var result = null;
  if (state.status !== 'not_in_phase') {
    result = {
      symbol:            sym,
      status:            state.status,
      direction:         state.direction,
      phase_start_time:  state.phase_start_time,
      cooling_start_time: state.cooling_start_time,
      cooling_ends_at:   state.cooling_start_time
        ? state.cooling_start_time + pd.cooling_timeout_minutes * 60 * 1000
        : null,
      revivals_count:    state.revivals_count,
      rvol_last:         +signals.rvol_last.toFixed(1),
      rvol_avg:          +signals.rvol_avg.toFixed(1),
      delta_price:       +signals.delta_price.toFixed(2),
      cvd_z:             signals.cvd_z !== null ? +signals.cvd_z.toFixed(2) : null,
    };
  }

  return { result: result, transitions: transitions };
}

// ── Public API ────────────────────────────────────────────────────────────

// pdOverride: full replacement of cfg.phase_detector (for backtest parameter sweeps)
function updatePhases(symbols, getBufferFn, getMicroFn, logFn, now, pdOverride) {
  var pd        = pdOverride || cfg.phase_detector;
  var nowTs     = now !== undefined ? now : Date.now();
  var getBuffer = getBufferFn || require('./buffers').getBuffer;
  var getMicro  = getMicroFn  || defaultGetMicro;

  var phases      = [];
  var transitions = [];

  for (var i = 0; i < symbols.length; i++) {
    var sym   = symbols[i];
    var buf5m = getBuffer(sym, '5m');
    if (!buf5m || !buf5m.length) continue;

    var r = stepSymbol(sym, buf5m, getMicro, nowTs, pd, logFn);
    if (r.result) phases.push(r.result);
    for (var j = 0; j < r.transitions.length; j++) transitions.push(r.transitions[j]);
  }

  return { phases: phases, transitions: transitions };
}

function resetState() { _state = {}; }

// Returns true if symbol is in active or cooling phase (not safe to remove from watchlist)
function isInPhase(sym) {
  return !!(_state[sym] && _state[sym].status !== 'not_in_phase');
}

module.exports = {
  updatePhases:    updatePhases,
  resetState:      resetState,
  isInPhase:       isInPhase,
  defaultGetMicro: defaultGetMicro,
};
