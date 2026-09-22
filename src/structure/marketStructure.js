'use strict';

const config = require('../config');
const { detectSwings } = require('./swings');
const { averageRange, highestHigh, lowestLow } = require('../util/candles');

/**
 * BOS / CHoCH engine.
 *
 *   BOS   (Break of Structure)     — a break that CONTINUES the current trend,
 *                                    or the first break from a neutral state.
 *   CHoCH (Change of Character)    — a break AGAINST the current trend; the
 *                                    first sign the trend is flipping.
 *
 * The engine walks the series candle by candle, so a swing can only be used
 * once it has been confirmed (see swings.js `confirmedAt`). Breaks are judged
 * on the candle close by default — a wick through a level is a liquidity
 * sweep, not a structural break.
 */
function analyzeStructure(candles, opts = {}) {
  const cfg = { ...config.structure, ...opts };
  const swings = opts.swings || detectSwings(candles, cfg.swingLookback);

  const events = [];
  let trend = 'neutral';
  let pendingHigh = null; // most recent confirmed swing high not yet broken
  let pendingLow = null;
  // Tracked per side: a level is only invalidated by a break of that same side,
  // so an old swing high stays a valid bullish reference after a bearish break.
  let lastUpBreakIndex = -1;
  let lastDownBreakIndex = -1;

  // Index swings by the candle at which they become known.
  const byConfirm = new Map();
  for (const s of swings) {
    if (!byConfirm.has(s.confirmedAt)) byConfirm.set(s.confirmedAt, []);
    byConfirm.get(s.confirmedAt).push(s);
  }

  for (let i = 0; i < candles.length; i += 1) {
    for (const s of byConfirm.get(i) || []) {
      // Only adopt swings formed at or after the last break of that side, so a
      // level already traded through is never re-used as a reference.
      if (s.type === 'high' && s.index >= lastUpBreakIndex) pendingHigh = s;
      if (s.type === 'low' && s.index >= lastDownBreakIndex) pendingLow = s;
    }

    const c = candles[i];
    const upLevel = cfg.breakOnClose ? c.close : c.high;
    const downLevel = cfg.breakOnClose ? c.close : c.low;
    const noiseFloor = cfg.minBreakAtrFactor > 0 ? cfg.minBreakAtrFactor * averageRange(candles, 20, i) : 0;

    if (pendingHigh && upLevel > pendingHigh.price + noiseFloor) {
      events.push(
        buildEvent({
          candles,
          i,
          direction: 'bullish',
          type: trend === 'bearish' ? 'CHoCH' : 'BOS',
          previousTrend: trend,
          brokenSwing: pendingHigh,
          counterSwing: pendingLow,
          breakPrice: upLevel,
        })
      );
      trend = 'bullish';
      lastUpBreakIndex = i;
      pendingHigh = null;
      // The low that protected this leg stays live until a new one is confirmed.
    } else if (pendingLow && downLevel < pendingLow.price - noiseFloor) {
      events.push(
        buildEvent({
          candles,
          i,
          direction: 'bearish',
          type: trend === 'bullish' ? 'CHoCH' : 'BOS',
          previousTrend: trend,
          brokenSwing: pendingLow,
          counterSwing: pendingHigh,
          breakPrice: downLevel,
        })
      );
      trend = 'bearish';
      lastDownBreakIndex = i;
      pendingLow = null;
    }
  }

  const lastEvent = events.length ? events[events.length - 1] : null;

  return {
    trend,
    events,
    lastEvent,
    swings,
    pendingHigh,
    pendingLow,
  };
}

function buildEvent({ candles, i, direction, type, previousTrend, brokenSwing, counterSwing, breakPrice }) {
  // The impulse leg runs from the origin of the move to the breaking candle.
  const originIndex = counterSwing && counterSwing.index > brokenSwing.index ? counterSwing.index : brokenSwing.index;
  const legHigh = highestHigh(candles, originIndex, i);
  const legLow = lowestLow(candles, originIndex, i);

  return {
    index: i,
    time: candles[i].time,
    type,
    direction,
    previousTrend,
    trend: direction,
    breakPrice,
    brokenSwing: { index: brokenSwing.index, time: brokenSwing.time, price: brokenSwing.price, type: brokenSwing.type },
    originIndex,
    leg: { high: legHigh.price, highIndex: legHigh.index, low: legLow.price, lowIndex: legLow.index },
  };
}

/** Most recent event whose direction matches, or null. */
function lastEventInDirection(structure, direction) {
  for (let i = structure.events.length - 1; i >= 0; i -= 1) {
    if (structure.events[i].direction === direction) return structure.events[i];
  }
  return null;
}

/** Human-readable one-liner for an event. */
function describeEvent(event) {
  if (!event) return 'no structural break detected';
  const what = event.type === 'CHoCH' ? 'Change of character' : 'Break of structure';
  const dir = event.direction === 'bullish' ? 'upside' : 'downside';
  return `${what} to the ${dir} — ${event.direction === 'bullish' ? 'high' : 'low'} at ${event.brokenSwing.price} broken`;
}

module.exports = { analyzeStructure, lastEventInDirection, describeEvent };
