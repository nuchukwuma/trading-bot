'use strict';

const { averageRange } = require('../util/candles');

const DEFAULTS = {
  avgPeriod: 20,
  // How far back a structural break may be and still count as "recently retested".
  lookback: 30,
  // A retest counts when price comes within this fraction of average range.
  retestTolerance: 0.4,
  // The retest has to be recent price action, not a dip back at some point in
  // the distant past — otherwise the token fires on almost every setup and
  // discriminates nothing.
  retestRecency: 8,
  // How close price must be to a breaker for it to be in play.
  proximity: 1.0,
};

/**
 * Structural price-action features.
 *
 * These read the relationship between structure, POIs and price rather than
 * candle shapes, which is what separates them from `patterns.js`.
 *
 * As with every other detector here, nothing decides anything: each returns a
 * token, and the learner establishes from outcomes whether it predicts. A
 * concept that sounds right but does not pay simply never earns a rule.
 */
function detectPriceActionFeatures({ candles, structure, pois = [], direction, entryPoi, price, opts = {} } = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const found = [];
  if (!candles || candles.length < 10 || !direction) return found;

  const avg = averageRange(candles, cfg.avgPeriod);
  if (avg <= 0) return found;

  if (isBreakAndRetest(candles, structure, direction, avg, cfg)) found.push('break_retest');
  if (isBreakerBlock(pois, direction, price, avg, cfg)) found.push('breaker_block');

  const inducement = findInducement(candles, structure, direction, entryPoi, avg, cfg);
  if (inducement.taken) found.push('inducement');
  if (inducement.ahead) found.push('inducement_ahead');

  return found;
}

/**
 * Break and retest (support/resistance flip).
 *
 * A level is broken by a close, price comes back to it, and it holds in its new
 * role: the candle wicks into the level and closes back on the breaking side.
 */
function isBreakAndRetest(candles, structure, direction, avg, cfg) {
  const events = (structure && structure.events) || [];
  const lastIndex = candles.length - 1;
  const tolerance = avg * cfg.retestTolerance;

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (lastIndex - event.index > cfg.lookback) break; // older events are stale
    if (event.direction !== direction) continue;

    const level = event.brokenSwing.price;
    const earliest = Math.max(event.index + 1, lastIndex - cfg.retestRecency + 1);
    for (let j = earliest; j <= lastIndex; j += 1) {
      const candle = candles[j];
      const touched = direction === 'bullish' ? candle.low <= level + tolerance : candle.high >= level - tolerance;
      // Holding means closing back on the side the break came from.
      const held = direction === 'bullish' ? candle.close > level : candle.close < level;
      if (touched && held) return true;
    }
  }
  return false;
}

/**
 * Breaker block.
 *
 * An order block that FAILED — price closed clean through it — and is now being
 * approached from the other side, where it tends to hold in the opposite role.
 * The mitigation tracker already marks these zones `violated`.
 */
function isBreakerBlock(pois, direction, price, avg, cfg) {
  if (!Number.isFinite(price)) return false;
  const opposite = direction === 'bullish' ? 'bearish' : 'bullish';
  const tolerance = avg * cfg.proximity;

  return pois.some(
    (poi) =>
      poi.direction === opposite &&
      poi.violated &&
      price >= poi.bottom - tolerance &&
      price <= poi.top + tolerance
  );
}

/**
 * Inducement.
 *
 * A minor pool of liquidity resting between price and the real POI. Price
 * typically grabs it on the way into the zone, and a setup entered before it is
 * taken is entered too early.
 *
 *   `inducement`        the minor pool has already been swept
 *   `inducement_ahead`  one is still sitting there untaken
 *
 * Both are recorded: whether taking it first actually matters is the learner's
 * question, not the detector's.
 */
function findInducement(candles, structure, direction, entryPoi, avg, cfg) {
  const result = { taken: false, ahead: false };
  if (!entryPoi) return result;

  const swings = (structure && structure.swings) || [];
  const lastIndex = candles.length - 1;
  const from = Math.max(0, lastIndex - cfg.lookback);
  const type = direction === 'bullish' ? 'low' : 'high';
  // The pool has to sit on the near side of the zone — between price and the POI.
  const poiEdge = direction === 'bullish' ? entryPoi.top : entryPoi.bottom;

  for (const swing of swings) {
    if (swing.type !== type) continue;
    if (swing.index < from || swing.confirmedAt > lastIndex) continue;
    const beyondPoi = direction === 'bullish' ? swing.price > poiEdge : swing.price < poiEdge;
    if (!beyondPoi) continue;

    if (wasSwept(candles, swing, direction, lastIndex)) result.taken = true;
    else result.ahead = true;
  }

  return result;
}

function wasSwept(candles, swing, direction, lastIndex) {
  for (let j = swing.confirmedAt; j <= lastIndex; j += 1) {
    const candle = candles[j];
    const pierced = direction === 'bullish' ? candle.low < swing.price : candle.high > swing.price;
    const closedBack = direction === 'bullish' ? candle.close > swing.price : candle.close < swing.price;
    if (pierced && closedBack) return true;
  }
  return false;
}

module.exports = {
  detectPriceActionFeatures,
  isBreakAndRetest,
  isBreakerBlock,
  findInducement,
  PRICE_ACTION_DEFAULTS: DEFAULTS,
};
