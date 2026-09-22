'use strict';

const config = require('../config');
const { isBullish, isBearish, averageRange, highestHigh, lowestLow } = require('../util/candles');
const { isDisplacementCandle } = require('../structure/displacement');

const DEFAULTS = {
  impulseLookahead: 5,
  // The impulse must travel at least this multiple of the average range beyond
  // the order block before the block counts as one.
  minImpulseFactor: 1.0,
  requireDisplacement: true,
  avgPeriod: 20,
};

/**
 * Order block detection.
 *
 * Bullish OB  — the last DOWN candle before an up-move that displaces away and
 *               takes out the candle's own high. Zone = that candle's full range.
 * Bearish OB  — the last UP candle before a down-move that displaces away and
 *               takes out the candle's own low.
 *
 * Requiring the very next candle to move in the impulse direction is what makes
 * it the *last* opposing candle rather than just any candle before a rally.
 */
function detectOrderBlocks(candles, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const out = [];
  if (!candles || candles.length < 3) return out;

  for (let i = 0; i < candles.length - 1; i += 1) {
    const c = candles[i];
    const next = candles[i + 1];
    const avg = averageRange(candles, cfg.avgPeriod, i);
    if (avg <= 0) continue;

    const to = Math.min(i + cfg.impulseLookahead, candles.length - 1);

    // ---- bullish order block ----
    if (isBearish(c) && isBullish(next)) {
      const hh = highestHigh(candles, i + 1, to);
      const travel = hh.price - c.high;
      if (travel >= cfg.minImpulseFactor * avg) {
        const disp = cfg.requireDisplacement ? findImpulseDisplacement(candles, i + 1, to, 'bullish', cfg) : null;
        const endIndex = disp ? disp.index : hh.index;
        if ((!cfg.requireDisplacement || disp) && isCleanImpulse(candles, i + 1, endIndex, 'bullish')) {
          out.push(makeOB('bullish', c, i, travel / avg, disp, hh.index));
        }
      }
    }

    // ---- bearish order block ----
    if (isBullish(c) && isBearish(next)) {
      const ll = lowestLow(candles, i + 1, to);
      const travel = c.low - ll.price;
      if (travel >= cfg.minImpulseFactor * avg) {
        const disp = cfg.requireDisplacement ? findImpulseDisplacement(candles, i + 1, to, 'bearish', cfg) : null;
        const endIndex = disp ? disp.index : ll.index;
        if ((!cfg.requireDisplacement || disp) && isCleanImpulse(candles, i + 1, endIndex, 'bearish')) {
          out.push(makeOB('bearish', c, i, travel / avg, disp, ll.index));
        }
      }
    }
  }

  return out;
}

/**
 * The order block must be the LAST opposing candle before the impulse: if any
 * candle between it and the impulse pushes back the other way, the block that
 * actually caused the move is a later one, not this candidate.
 */
function isCleanImpulse(candles, from, endIndex, direction) {
  for (let j = from; j < endIndex; j += 1) {
    const candle = candles[j];
    if (direction === 'bullish' && isBearish(candle)) return false;
    if (direction === 'bearish' && isBullish(candle)) return false;
  }
  return true;
}

function findImpulseDisplacement(candles, from, to, direction, cfg) {
  for (let j = from; j <= to; j += 1) {
    const d = isDisplacementCandle(candles, j, {
      avgPeriod: cfg.avgPeriod,
      bodyMultiple: cfg.displacementBodyMultiple || config.displacement.bodyMultiple,
    });
    if (d && d.direction === direction) return d;
  }
  return null;
}

function makeOB(direction, candle, index, strength, displacement, impulseIndex) {
  return {
    kind: 'OB',
    direction,
    index,
    time: candle.time,
    top: candle.high,
    bottom: candle.low,
    strength,
    displacementIndex: displacement ? displacement.index : null,
    impulseIndex,
    // Mitigation only counts as a RETURN to the zone, so the impulse leg that
    // created the block (which often originates inside it) is skipped.
    mitigationFrom: impulseIndex + 1,
  };
}

module.exports = { detectOrderBlocks, ORDER_BLOCK_DEFAULTS: DEFAULTS };
