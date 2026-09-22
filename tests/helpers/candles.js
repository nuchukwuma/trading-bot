'use strict';

/**
 * Test helpers for building deterministic candle series.
 * `c()` builds a single candle; `series()` builds a sequence with 30m spacing.
 */

const BASE_TIME = 1700000000; // fixed epoch so tests never depend on "now"

function c(time, open, high, low, close, volume = 0) {
  return { time, open, high, low, close, volume };
}

/**
 * Build candles from compact specs: [open, high, low, close] tuples.
 * Times start at `start` and step by `tf` seconds.
 */
function series(specs, { start = BASE_TIME, tf = 1800 } = {}) {
  return specs.map((s, i) => c(start + i * tf, s[0], s[1], s[2], s[3], s[4] || 0));
}

/** A candle whose body spans open->close with small symmetric wicks. */
function bodyCandle(time, open, close, wick = 0.1) {
  const hi = Math.max(open, close) + wick;
  const lo = Math.min(open, close) - wick;
  return c(time, open, hi, lo, close);
}

/**
 * A simple zig-zag leg generator: walks price from `from` to `to` over `steps`
 * candles, producing clean trending candles.
 */
function leg(startTime, from, to, steps, { tf = 1800, wick = 0.2 } = {}) {
  const out = [];
  const delta = (to - from) / steps;
  for (let i = 0; i < steps; i += 1) {
    const o = from + delta * i;
    const cl = from + delta * (i + 1);
    out.push(bodyCandle(startTime + i * tf, Number(o.toFixed(6)), Number(cl.toFixed(6)), wick));
  }
  return out;
}

/** Concatenate legs, keeping times continuous. */
function chain(startTime, legs, { tf = 1800, wick = 0.2 } = {}) {
  let t = startTime;
  let out = [];
  for (const [from, to, steps] of legs) {
    out = out.concat(leg(t, from, to, steps, { tf, wick }));
    t += steps * tf;
  }
  return out;
}

module.exports = { BASE_TIME, c, series, bodyCandle, leg, chain };

/**
 * `n` low-volatility candles of range 1.0 oscillating around `price`.
 * Used as a quiet backdrop so displacement/impulse thresholds are meaningful.
 */
function noise(n, price = 100, { start = BASE_TIME, tf = 1800 } = {}) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const up = i % 2 === 0;
    const o = up ? price : price + 0.2;
    const cl = up ? price + 0.2 : price - 0.2;
    out.push(c(start + i * tf, o, price + 0.5, price - 0.5, cl));
  }
  return out;
}

module.exports.noise = noise;

/**
 * A complete bullish 30m fixture:
 *   10  swing low at 98
 *   13  swing high at 103
 *   17  wick sweep below 98 (low 97) closing back inside
 *   18  bearish order block 98.80-99.80
 *   19  bullish displacement closing 103.40 -> BOS over 103
 *   20  leaves a bullish FVG 99.80-102.80
 *   21-22 shallow retrace back into the FVG, last close 101.50
 */
function bullishScenario() {
  const at = (i) => BASE_TIME + i * 1800;
  return [
    ...noise(10, 100),
    c(at(10), 100, 100.5, 98.0, 99.0),
    c(at(11), 99.0, 100.0, 98.8, 99.8),
    c(at(12), 99.8, 101.0, 99.5, 100.8),
    c(at(13), 100.8, 103.0, 100.5, 102.8),
    c(at(14), 102.8, 102.9, 101.0, 101.2),
    c(at(15), 101.2, 101.5, 99.5, 99.8),
    c(at(16), 99.8, 100.0, 98.5, 99.2),
    c(at(17), 99.2, 99.5, 97.0, 99.3),
    c(at(18), 99.3, 99.8, 98.8, 98.9),
    c(at(19), 98.9, 103.5, 98.8, 103.4),
    c(at(20), 103.4, 104.0, 102.8, 103.6),
    c(at(21), 103.6, 103.8, 101.5, 101.7),
    c(at(22), 101.7, 101.9, 101.4, 101.5),
  ];
}

module.exports.bullishScenario = bullishScenario;

/**
 * A bullish scenario that survives every gate: the same sweep -> displacement
 * -> BOS sequence, but price runs well past the old highs before retracing
 * into the order block, so there is untapped liquidity left to target.
 */
function bullishFiringScenario() {
  const at = (i) => BASE_TIME + i * 1800;
  return [
    ...noise(10, 100),
    c(at(10), 100, 100.5, 98.0, 99.0), // swing low 98
    c(at(11), 99.0, 100.0, 98.8, 99.8),
    c(at(12), 99.8, 101.0, 99.5, 100.8),
    c(at(13), 100.8, 103.0, 100.5, 102.8), // swing high 103
    c(at(14), 102.8, 102.9, 101.0, 101.2),
    c(at(15), 101.2, 101.5, 99.5, 99.8),
    c(at(16), 99.8, 100.0, 98.5, 99.2),
    c(at(17), 99.2, 99.5, 97.0, 99.3), // sweep below 98
    c(at(18), 99.3, 99.8, 98.8, 98.9), // order block 98.80-99.80
    c(at(19), 98.9, 103.5, 98.8, 103.4), // displacement -> BOS over 103
    c(at(20), 103.4, 108.0, 102.8, 107.5), // expansion
    c(at(21), 107.5, 108.2, 106.0, 106.5), // swing high 108.20, still untapped
    c(at(22), 106.5, 106.8, 103.0, 103.2),
    c(at(23), 103.2, 103.5, 100.0, 100.2),
    c(at(24), 100.2, 100.4, 99.4, 99.5), // retrace into the order block
  ];
}

module.exports.bullishFiringScenario = bullishFiringScenario;

/**
 * The 4H backdrop for the firing scenario: the same sequence truncated before
 * the retrace, so the HTF read is a clean uptrend with the demand zone still
 * unmitigated and nothing opposing overhead.
 */
function bullishHtfScenario() {
  return bullishFiringScenario().slice(0, 22);
}

module.exports.bullishHtfScenario = bullishHtfScenario;
