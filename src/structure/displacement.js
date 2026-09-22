'use strict';

const config = require('../config');
const { body, averageRange, isBullish, isBearish } = require('../util/candles');

/**
 * Displacement detection.
 *
 * A displacement candle is the aggressive candle that DRIVES a structural move:
 * its body is at least `bodyMultiple` times the average candle range of the
 * preceding `avgPeriod` candles. The average deliberately excludes the candle
 * being tested, so a single huge candle cannot raise its own bar.
 */
function isDisplacementCandle(candles, index, opts = {}) {
  const cfg = { ...config.displacement, ...opts };
  const candle = candles[index];
  if (!candle) return null;

  const avg = averageRange(candles, cfg.avgPeriod, index - 1);
  if (avg <= 0) return null;

  const size = body(candle);
  const ratio = size / avg;
  if (ratio < cfg.bodyMultiple) return null;

  return {
    index,
    time: candle.time,
    direction: isBullish(candle) ? 'bullish' : isBearish(candle) ? 'bearish' : 'neutral',
    body: size,
    averageRange: avg,
    ratio,
  };
}

/**
 * Find the displacement candle that drove a move, looking back from `index`.
 * Returns the strongest match in the window, or null.
 */
function findDisplacement(candles, index, direction, opts = {}) {
  const cfg = { ...config.displacement, ...opts };
  const from = Math.max(0, index - cfg.lookback + 1);
  let best = null;

  for (let i = from; i <= Math.min(index, candles.length - 1); i += 1) {
    const d = isDisplacementCandle(candles, i, cfg);
    if (!d) continue;
    if (direction && d.direction !== direction) continue;
    if (!best || d.ratio > best.ratio) best = d;
  }

  return best;
}

function describeDisplacement(d) {
  if (!d) return 'no displacement candle found';
  return `Displacement candle drove the move — body ${d.ratio.toFixed(1)}x the ${
    config.displacement.avgPeriod
  }-period average range`;
}

module.exports = { isDisplacementCandle, findDisplacement, describeDisplacement };
