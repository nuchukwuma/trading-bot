'use strict';

const config = require('../config');
const { averageRange, lowerWick, upperWick, body } = require('../util/candles');
const { formatPrice } = require('../util/format');

/**
 * Liquidity sweeps.
 *
 * Two kinds are counted, as required by the confirmation scorer:
 *
 *  1. EQH / EQL — two or more swing highs (or lows) resting at effectively the
 *     same price. Stops pile up just beyond them, so a run through the cluster
 *     is an engineered liquidity grab.
 *  2. Single-candle wick sweep — one candle spikes through a prior swing point
 *     and CLOSES back inside. The wick took the stops; the close rejected the
 *     level.
 *
 * A sweep for a LONG is a sweep of the SELL side (lows taken before price turns
 * up); a sweep for a SHORT is a sweep of the BUY side (highs taken).
 */

/** Price tolerance for "equal" levels, derived from recent average range. */
function equalTolerance(candles, opts = {}) {
  const cfg = { ...config.liquidity, ...opts };
  if (Number.isFinite(opts.tolerance)) return opts.tolerance;
  return cfg.equalLevelAtrFactor * averageRange(candles, 20);
}

/**
 * Cluster swings of one type into equal-level groups.
 * `price` is where the stops actually rest: below the lowest equal low, above
 * the highest equal high.
 */
function findEqualLevels(swings, type, tolerance) {
  const list = swings.filter((s) => s.type === type).sort((a, b) => a.index - b.index);
  const groups = [];
  const used = new Set();

  for (let i = 0; i < list.length; i += 1) {
    if (used.has(i)) continue;
    const members = [list[i]];
    for (let j = i + 1; j < list.length; j += 1) {
      if (used.has(j)) continue;
      if (Math.abs(list[j].price - list[i].price) <= tolerance) {
        members.push(list[j]);
        used.add(j);
      }
    }
    if (members.length >= 2) {
      used.add(i);
      const prices = members.map((m) => m.price);
      groups.push({
        type: type === 'high' ? 'EQH' : 'EQL',
        price: type === 'high' ? Math.max(...prices) : Math.min(...prices),
        count: members.length,
        members,
        lastIndex: members[members.length - 1].index,
      });
    }
  }

  return groups;
}

/**
 * Find liquidity sweeps that happened in the window leading up to `breakIndex`.
 *
 * @param {Array}  candles
 * @param {Array}  swings    output of detectSwings (carrying `confirmedAt`)
 * @param {Object} opts      { breakIndex, direction, lookback, tolerance }
 * @returns {Array} sweeps, most significant first
 */
function detectSweeps(candles, swings, opts = {}) {
  const cfg = { ...config.liquidity, ...opts };
  const breakIndex = Number.isFinite(opts.breakIndex) ? opts.breakIndex : candles.length - 1;
  const direction = opts.direction || 'bullish';
  const sweepType = direction === 'bullish' ? 'low' : 'high'; // longs sweep lows, shorts sweep highs
  const tolerance = equalTolerance(candles, opts);

  const from = Math.max(0, breakIndex - cfg.sweepLookback);
  const equalGroups = findEqualLevels(swings, sweepType, tolerance);
  const sweeps = new Map(); // keyed by swept level so one level reports once

  for (let j = from; j <= Math.min(breakIndex, candles.length - 1); j += 1) {
    const candle = candles[j];
    const wick = direction === 'bullish' ? lowerWick(candle) : upperWick(candle);
    const candleBody = body(candle);

    // The wick must dominate the body — that is what makes it a rejection.
    if (cfg.minWickBodyRatio > 0 && candleBody > 0 && wick < candleBody * cfg.minWickBodyRatio) continue;

    for (const swing of swings) {
      if (swing.type !== sweepType) continue;
      if (swing.index >= j) continue; // only prior swings can be swept
      if (swing.confirmedAt > j) continue; // and only ones already known

      const pierced = direction === 'bullish' ? candle.low < swing.price : candle.high > swing.price;
      const closedBack = direction === 'bullish' ? candle.close > swing.price : candle.close < swing.price;
      if (!pierced || !closedBack) continue;

      const group = equalGroups.find((g) => g.members.some((m) => m.index === swing.index));
      const level = group ? group.price : swing.price;
      const depth = direction === 'bullish' ? swing.price - candle.low : candle.high - swing.price;

      const sweep = {
        type: group ? group.type : 'wick',
        direction,
        level,
        // The wick extreme — this is what a protective stop sits beyond.
        extreme: direction === 'bullish' ? candle.low : candle.high,
        depth,
        index: j,
        time: candle.time,
        sweptSwingIndex: swing.index,
        equalCount: group ? group.count : 1,
        reason: sweepReason(group, direction, level, opts.instrument),
      };

      const key = `${sweep.type}:${round6(level)}`;
      const existing = sweeps.get(key);
      if (!existing || sweep.index > existing.index) sweeps.set(key, sweep);
    }
  }

  return [...sweeps.values()].sort((a, b) => b.equalCount - a.equalCount || b.index - a.index);
}

function sweepReason(group, direction, level, instrument) {
  const side = direction === 'bullish' ? 'below' : 'above';
  if (group) {
    const what = group.type === 'EQH' ? 'Equal highs' : 'Equal lows';
    return `Liquidity sweep before shift — ${what.toLowerCase()} (${group.count}) at ${formatPrice(
      level,
      instrument
    )} taken out before the reversal`;
  }
  return `Liquidity sweep before shift — stop hunt ${side} the prior swing at ${formatPrice(
    level,
    instrument
  )}, wick rejected back inside`;
}

/** The nearest untapped liquidity pool beyond `price` — used as a TP3 target. */
function nextLiquidityPool(swings, price, direction, opts = {}) {
  const type = direction === 'bullish' ? 'high' : 'low';
  const candidates = swings
    .filter((s) => s.type === type)
    .filter((s) => (direction === 'bullish' ? s.price > price : s.price < price));
  if (!candidates.length) return null;

  // Prefer equal-level clusters (more resting stops) then the closest level.
  const groups = findEqualLevels(swings, type, opts.tolerance || 0);
  const clustered = groups
    .map((g) => ({ price: g.price, count: g.count, type: g.type }))
    .filter((g) => (direction === 'bullish' ? g.price > price : g.price < price));

  if (clustered.length) {
    clustered.sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price));
    return { price: clustered[0].price, kind: clustered[0].type, count: clustered[0].count };
  }

  candidates.sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price));
  return { price: candidates[0].price, kind: 'swing', count: 1 };
}

const round6 = (n) => Number(n.toFixed(6));

module.exports = { findEqualLevels, detectSweeps, nextLiquidityPool, equalTolerance };
