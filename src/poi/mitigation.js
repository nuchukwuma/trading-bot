'use strict';

const config = require('../config');
const { clamp, overlaps, overlap } = require('../util/math');
const { formatPrice } = require('../util/format');

/**
 * POI zone geometry and mitigation tracking.
 *
 *  proximal edge — the side price reaches FIRST when returning to the zone.
 *                  Bullish (demand): the top. Bearish (supply): the bottom.
 *  distal edge   — the far side, where the protective stop belongs.
 *
 * A POI is MITIGATED once price has traded through `mitigationFillRatio` of the
 * zone; an untouched or only lightly tagged zone stays UNMITIGATED and is still
 * "live" for the bias engine.
 */
const height = (poi) => Math.max(0, poi.top - poi.bottom);
const proximalEdge = (poi) => (poi.direction === 'bullish' ? poi.top : poi.bottom);
const distalEdge = (poi) => (poi.direction === 'bullish' ? poi.bottom : poi.top);
const midpoint = (poi) => (poi.top + poi.bottom) / 2;

function containsPrice(poi, price) {
  return price >= poi.bottom && price <= poi.top;
}

/**
 * Walk the candles after a POI formed and record how deeply price traded into it.
 * Returns a NEW poi object; the input is not mutated.
 */
function updateMitigation(poi, candles, opts = {}) {
  const cfg = { ...config.poi, ...opts };
  const h = height(poi);
  const bullish = poi.direction === 'bullish';

  let deepest = 0;
  let touchedIndex = null;
  let mitigatedIndex = null;
  let violatedIndex = null;

  // Order blocks carry `mitigationFrom` so the impulse leg that created them is
  // not mistaken for a return into the zone; everything else starts immediately.
  const from = Number.isFinite(poi.mitigationFrom) ? poi.mitigationFrom : poi.index + 1;

  for (let j = from; j < candles.length; j += 1) {
    const c = candles[j];
    const penetration = bullish ? poi.top - c.low : c.high - poi.bottom;
    if (penetration <= 0) continue;

    if (touchedIndex === null) touchedIndex = j;

    // A zero-height zone (a single price level) is fully mitigated by any touch.
    const fill = h > 0 ? clamp(penetration / h, 0, 1) : 1;
    if (fill > deepest) deepest = fill;
    if (mitigatedIndex === null && deepest >= cfg.mitigationFillRatio) mitigatedIndex = j;

    // Closing beyond the distal edge invalidates the zone entirely.
    const closedThrough = bullish ? c.close < poi.bottom : c.close > poi.top;
    if (violatedIndex === null && closedThrough) violatedIndex = j;
  }

  return {
    ...poi,
    fill: deepest,
    touched: touchedIndex !== null,
    touchedIndex,
    touchedTime: touchedIndex !== null ? candles[touchedIndex].time : null,
    mitigated: mitigatedIndex !== null,
    mitigatedIndex,
    mitigatedTime: mitigatedIndex !== null ? candles[mitigatedIndex].time : null,
    violated: violatedIndex !== null,
    violatedIndex,
  };
}

/** Is price currently trading inside the zone (i.e. reacting to it)? */
function isReactingTo(poi, price) {
  return containsPrice(poi, price);
}

/**
 * Is price approaching the zone from the correct side, within
 * `approachZoneMultiple` zone-heights of the proximal edge?
 */
function isApproaching(poi, price, opts = {}) {
  const cfg = { ...config.poi, ...opts };
  if (containsPrice(poi, price)) return false;
  const h = height(poi) || Math.abs(price) * 1e-4;
  const distance = cfg.approachZoneMultiple * h;
  if (poi.direction === 'bullish') {
    // Demand sits below price; approaching means falling towards the top.
    return price > poi.top && price - poi.top <= distance;
  }
  // Supply sits above price; approaching means rallying towards the bottom.
  return price < poi.bottom && poi.bottom - price <= distance;
}

/** Do two zones share any price? */
function zonesOverlap(a, b) {
  return overlaps(a.bottom, a.top, b.bottom, b.top);
}

/** Fraction of zone `a` that is covered by zone `b` (0..1). */
function overlapRatio(a, b) {
  const h = height(a);
  if (h <= 0) return zonesOverlap(a, b) ? 1 : 0;
  return overlap(a.bottom, a.top, b.bottom, b.top) / h;
}

function describePoi(poi, instrument) {
  const kind = poi.kind === 'OB' ? 'order block' : 'fair value gap';
  const side = poi.direction === 'bullish' ? 'demand' : 'supply';
  const state = poi.mitigated ? 'mitigated' : 'unmitigated';
  return `${state} ${poi.direction} ${kind} (${side}) ${formatPrice(poi.bottom, instrument)}-${formatPrice(
    poi.top,
    instrument
  )}`;
}

module.exports = {
  height,
  proximalEdge,
  distalEdge,
  midpoint,
  containsPrice,
  updateMitigation,
  isReactingTo,
  isApproaching,
  zonesOverlap,
  overlapRatio,
  describePoi,
};
