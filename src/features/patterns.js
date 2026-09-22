'use strict';

const { detectSwings } = require('../structure/swings');
const { averageRange, body, upperWick, lowerWick, isBullish, isBearish, range } = require('../util/candles');

const DEFAULTS = {
  // Two swings count as the same level within this fraction of average range.
  levelTolerance: 0.35,
  // How many swings back the pattern scanner looks.
  swingWindow: 6,
  // Minimum bars between the two touches of a double top/bottom.
  minSeparation: 3,
  swingLookback: 2,
  avgPeriod: 20,
};

/**
 * Chart pattern detection.
 *
 * These are CANDIDATE features, not signals. Nothing here decides anything —
 * each detected pattern becomes a token attached to the trade record, and the
 * learner works out from outcomes whether it carries any edge. A pattern that
 * turns out to be worthless simply never makes it into the profile.
 *
 * Detection runs on the window ending at the signal bar, so it only ever sees
 * closed candles.
 */
function detectPatterns(candles, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  if (!candles || candles.length < 10) return [];

  const found = [];
  const swings = detectSwings(candles, cfg.swingLookback);
  const avg = averageRange(candles, cfg.avgPeriod);
  const tolerance = avg * cfg.levelTolerance;

  const highs = swings.filter((s) => s.type === 'high').slice(-cfg.swingWindow);
  const lows = swings.filter((s) => s.type === 'low').slice(-cfg.swingWindow);

  if (isDoubleLevel(lows, tolerance, cfg.minSeparation)) found.push('double_bottom');
  if (isDoubleLevel(highs, tolerance, cfg.minSeparation)) found.push('double_top');
  if (isHeadAndShoulders(highs, lows, tolerance, 'top')) found.push('head_shoulders');
  if (isHeadAndShoulders(lows, highs, tolerance, 'bottom')) found.push('inverse_head_shoulders');

  const trend = trendShape(highs, lows);
  if (trend) found.push(trend);

  found.push(...candlePatterns(candles, avg));

  return found;
}

/** Two of the last three swings resting at the same level, far enough apart. */
function isDoubleLevel(swings, tolerance, minSeparation) {
  const recent = swings.slice(-3);
  for (let i = 0; i < recent.length; i += 1) {
    for (let j = i + 1; j < recent.length; j += 1) {
      const a = recent[i];
      const b = recent[j];
      if (b.index - a.index < minSeparation) continue;
      if (Math.abs(a.price - b.price) <= tolerance) return true;
    }
  }
  return false;
}

/**
 * Three swings of one type where the middle is the extreme and the outer two
 * sit at a comparable level — the shoulders.
 */
function isHeadAndShoulders(primary, secondary, tolerance, kind) {
  const s = primary.slice(-3);
  if (s.length < 3) return false;
  const [left, head, right] = s;

  const headIsExtreme =
    kind === 'top' ? head.price > left.price && head.price > right.price : head.price < left.price && head.price < right.price;
  if (!headIsExtreme) return false;

  // Shoulders roughly level with each other, and the head clearly beyond them.
  if (Math.abs(left.price - right.price) > tolerance * 2) return false;
  const shoulder = (left.price + right.price) / 2;
  if (Math.abs(head.price - shoulder) < tolerance) return false;

  // A neckline needs at least one opposing swing between the shoulders.
  return secondary.some((x) => x.index > left.index && x.index < right.index);
}

/** Higher lows, lower highs, or both (compression). */
function trendShape(highs, lows) {
  const h = highs.slice(-3).map((s) => s.price);
  const l = lows.slice(-3).map((s) => s.price);
  const risingLows = l.length >= 3 && l[0] < l[1] && l[1] < l[2];
  const fallingHighs = h.length >= 3 && h[0] > h[1] && h[1] > h[2];

  if (risingLows && fallingHighs) return 'compression';
  if (risingLows) return 'higher_lows';
  if (fallingHighs) return 'lower_highs';
  return null;
}

/** Single- and two-candle formations on the signal bar. */
function candlePatterns(candles, avg) {
  const out = [];
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  if (!last || !prev || avg <= 0) return out;

  const lastBody = body(last);
  const prevBody = body(prev);

  // Engulfing: opposite colour and a body that swallows the previous one.
  if (isBullish(last) && isBearish(prev) && last.close >= prev.open && last.open <= prev.close && lastBody > prevBody) {
    out.push('engulfing_bull');
  }
  if (isBearish(last) && isBullish(prev) && last.close <= prev.open && last.open >= prev.close && lastBody > prevBody) {
    out.push('engulfing_bear');
  }

  // Pin bar: a wick at least twice the body, dominating the candle's range.
  const r = range(last);
  if (r > 0 && lastBody > 0) {
    if (lowerWick(last) >= lastBody * 2 && lowerWick(last) / r >= 0.5) out.push('pin_bar_bull');
    if (upperWick(last) >= lastBody * 2 && upperWick(last) / r >= 0.5) out.push('pin_bar_bear');
  }

  // Inside bar: the whole candle inside the previous one.
  if (last.high <= prev.high && last.low >= prev.low) out.push('inside_bar');

  // Narrow range: compression right before entry.
  if (r > 0 && r < avg * 0.5) out.push('narrow_range');

  return out;
}

module.exports = { detectPatterns, PATTERN_DEFAULTS: DEFAULTS };
