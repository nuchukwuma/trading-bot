'use strict';

const config = require('../config');

/**
 * Fractal swing detection.
 *
 * A swing high at index i needs `lookback` strictly lower highs on each side;
 * a swing low needs `lookback` strictly higher lows on each side. Strict
 * comparison means a pair of identical highs forms no fractal between them —
 * that is deliberate: those are equal highs (liquidity), handled by the
 * liquidity module, not by the structure engine.
 *
 * `confirmedAt` is the index of the candle at which the swing becomes KNOWN
 * (i + lookback). Everything downstream uses it to avoid look-ahead bias:
 * a swing may not be used to judge a break that happened before it existed.
 */
function detectSwings(candles, lookback = config.structure.swingLookback) {
  const swings = [];
  if (!Array.isArray(candles) || candles.length < lookback * 2 + 1) return swings;

  for (let i = lookback; i < candles.length - lookback; i += 1) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;

    for (let k = 1; k <= lookback; k += 1) {
      const left = candles[i - k];
      const right = candles[i + k];
      if (!(c.high > left.high && c.high > right.high)) isHigh = false;
      if (!(c.low < left.low && c.low < right.low)) isLow = false;
      if (!isHigh && !isLow) break;
    }

    if (isHigh) {
      swings.push({ type: 'high', index: i, price: c.high, time: c.time, confirmedAt: i + lookback });
    }
    if (isLow) {
      swings.push({ type: 'low', index: i, price: c.low, time: c.time, confirmedAt: i + lookback });
    }
  }

  return swings.sort((a, b) => a.index - b.index || (a.type === 'high' ? -1 : 1));
}

const swingHighs = (swings) => swings.filter((s) => s.type === 'high');
const swingLows = (swings) => swings.filter((s) => s.type === 'low');

/** Swings that are known (confirmed) at or before `index`. */
function swingsKnownAt(swings, index) {
  return swings.filter((s) => s.confirmedAt <= index);
}

/** The most recent swing of `type` known at `index`, or null. */
function lastSwing(swings, type, index = Infinity) {
  let found = null;
  for (const s of swings) {
    if (s.type !== type) continue;
    if (s.confirmedAt > index) continue;
    if (!found || s.index > found.index) found = s;
  }
  return found;
}

module.exports = { detectSwings, swingHighs, swingLows, swingsKnownAt, lastSwing };
