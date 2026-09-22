'use strict';

const config = require('../config');
const { averageRange } = require('../util/candles');
const { isDisplacementCandle } = require('../structure/displacement');

const DEFAULTS = {
  // Gaps thinner than this multiple of the average range are noise.
  minGapFactor: 0.1,
  requireDisplacement: false,
  avgPeriod: 20,
};

/**
 * Fair value gap (imbalance) detection over three candles.
 *
 * Bullish FVG — candle i's LOW is above candle (i-2)'s HIGH: price moved up so
 *               fast that the middle candle left an unfilled window.
 *               Zone = [high(i-2), low(i)].
 * Bearish FVG — candle i's HIGH is below candle (i-2)'s LOW.
 *               Zone = [high(i), low(i-2)].
 *
 * The gap is anchored at index i — the candle that completed it.
 */
function detectFVGs(candles, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const out = [];
  if (!candles || candles.length < 3) return out;

  for (let i = 2; i < candles.length; i += 1) {
    const first = candles[i - 2];
    const middle = candles[i - 1];
    const last = candles[i];
    const avg = averageRange(candles, cfg.avgPeriod, i);
    if (avg <= 0) continue;

    if (last.low > first.high) {
      const gap = last.low - first.high;
      if (gap >= cfg.minGapFactor * avg && passesDisplacement(candles, i - 1, 'bullish', cfg)) {
        out.push(makeFVG('bullish', last, i, first.high, last.low, gap / avg, middle));
      }
    }

    if (last.high < first.low) {
      const gap = first.low - last.high;
      if (gap >= cfg.minGapFactor * avg && passesDisplacement(candles, i - 1, 'bearish', cfg)) {
        out.push(makeFVG('bearish', last, i, last.high, first.low, gap / avg, middle));
      }
    }
  }

  return out;
}

function passesDisplacement(candles, middleIndex, direction, cfg) {
  if (!cfg.requireDisplacement) return true;
  const d = isDisplacementCandle(candles, middleIndex, {
    avgPeriod: cfg.avgPeriod,
    bodyMultiple: cfg.displacementBodyMultiple || config.displacement.bodyMultiple,
  });
  return Boolean(d && d.direction === direction);
}

function makeFVG(direction, candle, index, bottom, top, strength, middle) {
  return {
    kind: 'FVG',
    direction,
    index,
    time: candle.time,
    top,
    bottom,
    strength,
    middleTime: middle.time,
  };
}

module.exports = { detectFVGs, FVG_DEFAULTS: DEFAULTS };
