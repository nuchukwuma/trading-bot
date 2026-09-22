'use strict';

const config = require('../config');
const { highestHigh, lowestLow } = require('../util/candles');

/**
 * Dealing range + premium/discount.
 *
 * The dealing range is the leg price is currently trading inside. Above the
 * 50% equilibrium is PREMIUM (expensive — where smart money sells), below is
 * DISCOUNT (cheap — where smart money buys). Longs want discount entries,
 * shorts want premium entries.
 */
function dealingRange(candles, opts = {}) {
  const cfg = { ...config.premiumDiscount, ...opts };

  // Prefer the impulse leg of the latest structural break when one is supplied —
  // it is the range that actually matters, rather than an arbitrary window.
  if (opts.leg && Number.isFinite(opts.leg.high) && Number.isFinite(opts.leg.low) && opts.leg.high > opts.leg.low) {
    return finalize(opts.leg.low, opts.leg.high, cfg);
  }

  if (!candles || candles.length === 0) return null;
  const from = Math.max(0, candles.length - cfg.rangeLookback);
  const hi = highestHigh(candles, from, candles.length - 1);
  const lo = lowestLow(candles, from, candles.length - 1);
  if (!(hi.price > lo.price)) return null;
  return finalize(lo.price, hi.price, cfg);
}

function finalize(low, high, cfg) {
  const size = high - low;
  return {
    low,
    high,
    size,
    equilibrium: low + size * cfg.equilibrium,
    // Standard SMC "optimal trade entry" band: the 62-79% retracement of the leg.
    oteLong: { from: high - size * 0.79, to: high - size * 0.62 },
    oteShort: { from: low + size * 0.62, to: low + size * 0.79 },
  };
}

/** Where does `price` sit in the range? */
function zoneOf(price, range) {
  if (!range || range.size <= 0) return 'unknown';
  if (price > range.equilibrium) return 'premium';
  if (price < range.equilibrium) return 'discount';
  return 'equilibrium';
}

/** 0 at the range low, 1 at the range high. */
function positionInRange(price, range) {
  if (!range || range.size <= 0) return null;
  return (price - range.low) / range.size;
}

/**
 * Is `price` on the right side of equilibrium for `direction`?
 * Longs need discount, shorts need premium.
 */
function isFavourableZone(price, range, direction) {
  const zone = zoneOf(price, range);
  if (zone === 'unknown') return false;
  return direction === 'bullish' ? zone === 'discount' : zone === 'premium';
}

function describeZone(price, range, direction) {
  const pos = positionInRange(price, range);
  const pct = pos === null ? '?' : `${(pos * 100).toFixed(0)}%`;
  const zone = zoneOf(price, range);
  const want = direction === 'bullish' ? 'discount' : 'premium';
  return `Entry sits in ${zone} at ${pct} of the dealing range — ${direction === 'bullish' ? 'longs' : 'shorts'} want ${want}`;
}

module.exports = { dealingRange, zoneOf, positionInRange, isFavourableZone, describeZone };
