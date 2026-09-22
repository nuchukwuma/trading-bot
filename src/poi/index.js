'use strict';

const config = require('../config');
const { detectOrderBlocks } = require('./orderBlocks');
const { detectFVGs } = require('./fvg');
const mitigation = require('./mitigation');

/**
 * POI tracker.
 *
 * Builds the order blocks and fair value gaps on a series, resolves each one's
 * mitigation status against the candles that followed it, and keeps the most
 * recent `maxTracked` (5-10 by config) as the live set.
 */
function buildPOIs(candles, opts = {}) {
  const cfg = { ...config.poi, ...opts };
  const timeframe = opts.timeframe || null;

  const raw = [
    ...detectOrderBlocks(candles, opts.orderBlocks || {}),
    ...detectFVGs(candles, opts.fvg || {}),
  ];

  const lastIndex = candles.length - 1;
  const tracked = raw
    .filter((p) => lastIndex - p.index <= cfg.maxAgeCandles)
    .map((p) => mitigation.updateMitigation(p, candles, cfg))
    .map((p) => ({
      ...p,
      timeframe,
      id: poiId(p, timeframe),
      age: lastIndex - p.index,
      proximal: mitigation.proximalEdge(p),
      distal: mitigation.distalEdge(p),
      mid: mitigation.midpoint(p),
      height: mitigation.height(p),
    }))
    .sort((a, b) => b.index - a.index);

  return tracked.slice(0, cfg.maxTracked);
}

function poiId(poi, timeframe) {
  return [timeframe || 'tf', poi.kind, poi.direction, poi.time, round6(poi.bottom), round6(poi.top)].join(':');
}

const round6 = (n) => Number(n.toFixed(6));

/** Live zones: not yet mitigated and not invalidated. */
function unmitigated(pois, direction = null) {
  return pois.filter((p) => !p.mitigated && !p.violated && (!direction || p.direction === direction));
}

/** The nearest live POI to `price` on the side that matters for `direction`. */
function nearestUnmitigated(pois, price, direction) {
  const live = unmitigated(pois, direction);
  let best = null;
  let bestDist = Infinity;
  for (const p of live) {
    if (direction === 'bullish' && p.top > price) continue; // demand must sit below price
    if (direction === 'bearish' && p.bottom < price) continue; // supply must sit above price
    const dist = Math.abs(mitigation.proximalEdge(p) - price);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  return best;
}

/** Live POIs that price is currently trading inside. */
function poisContaining(pois, price, direction = null) {
  return unmitigated(pois, direction).filter((p) => mitigation.containsPrice(p, price));
}

/** Live POIs on the other timeframe that overlap `zone`. */
function overlappingPOIs(pois, zone, direction = null) {
  return unmitigated(pois, direction).filter((p) => mitigation.zonesOverlap(p, zone));
}

module.exports = {
  buildPOIs,
  unmitigated,
  nearestUnmitigated,
  poisContaining,
  overlappingPOIs,
  poiId,
  ...mitigation,
  detectOrderBlocks,
  detectFVGs,
};
