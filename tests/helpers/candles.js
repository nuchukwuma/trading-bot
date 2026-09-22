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
