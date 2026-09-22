'use strict';

const config = require('../config');
const { analyzeStructure, describeEvent } = require('./marketStructure');
const { dealingRange } = require('./range');
const poiLib = require('../poi');
const { formatPrice } = require('../util/format');

/**
 * HTF (4H) bias engine.
 *
 * The DIRECTION is the 4H structure direction — nothing else overrides it.
 * The STRENGTH is then adjusted by where price sits relative to the tracked
 * unmitigated 4H points of interest:
 *
 *   +1.0  price is reacting inside an unmitigated POI that agrees with the bias
 *   +0.5  price is approaching one
 *   -1.0  price is inside an unmitigated POI that OPPOSES the bias
 *   -0.5  price is approaching an opposing POI
 *
 * Score 0-3 maps to weak / moderate / strong.
 */
function computeBias(candles, opts = {}) {
  const cfg = { ...config.poi, ...(opts.poi || {}) };
  const structure = opts.structure || analyzeStructure(candles, opts.structureOpts || {});
  const pois = opts.pois || poiLib.buildPOIs(candles, { timeframe: opts.timeframe || config.timeframes.htf, ...cfg });
  const price = Number.isFinite(opts.price) ? opts.price : candles.length ? candles[candles.length - 1].close : null;

  const direction = structure.trend;
  const reasons = [];

  if (direction === 'neutral' || price === null) {
    return {
      direction: 'neutral',
      strength: 'none',
      score: 0,
      structure,
      pois,
      price,
      range: structure.lastEvent ? dealingRange(candles, { leg: structure.lastEvent.leg }) : dealingRange(candles),
      activePoi: null,
      approachingPoi: null,
      opposingPoi: null,
      reasons: ['4H structure has no confirmed direction yet — no bias'],
      lastEvent: structure.lastEvent || null,
    };
  }

  reasons.push(`4H bias is ${direction} — ${describeEvent(structure.lastEvent).toLowerCase()}`);

  const opposite = direction === 'bullish' ? 'bearish' : 'bullish';
  const aligned = poiLib.unmitigated(pois, direction);
  const opposing = poiLib.unmitigated(pois, opposite);

  let score = 1; // a clean structural direction on its own is "moderate"

  const activePoi = aligned.find((p) => poiLib.isReactingTo(p, price)) || null;
  const approachingPoi = activePoi ? null : aligned.find((p) => poiLib.isApproaching(p, price, cfg)) || null;
  const opposingActive = opposing.find((p) => poiLib.isReactingTo(p, price)) || null;
  const opposingApproach = opposingActive ? null : opposing.find((p) => poiLib.isApproaching(p, price, cfg)) || null;

  if (activePoi) {
    score += 1;
    reasons.push(`Price is reacting to an unmitigated 4H ${label(activePoi, opts.instrument)} — bias strengthened`);
  } else if (approachingPoi) {
    score += 0.5;
    reasons.push(`Price is approaching an unmitigated 4H ${label(approachingPoi, opts.instrument)} — bias firming up`);
  }

  if (opposingActive) {
    score -= 1;
    reasons.push(`Price is inside an opposing unmitigated 4H ${label(opposingActive, opts.instrument)} — bias weakened`);
  } else if (opposingApproach) {
    score -= 0.5;
    reasons.push(`Price is approaching an opposing unmitigated 4H ${label(opposingApproach, opts.instrument)} — bias weakened`);
  }

  if (!activePoi && !approachingPoi && aligned.length === 0) {
    reasons.push('No unmitigated 4H POI left in the direction of bias');
  }

  score = Math.max(0, Math.min(3, score));

  return {
    direction,
    strength: score >= 2 ? 'strong' : score >= 1 ? 'moderate' : 'weak',
    score,
    structure,
    pois,
    price,
    range: dealingRange(candles, structure.lastEvent ? { leg: structure.lastEvent.leg } : {}),
    activePoi,
    approachingPoi,
    opposingPoi: opposingActive || opposingApproach,
    reasons,
    lastEvent: structure.lastEvent,
  };
}

function label(poi, instrument) {
  const kind = poi.kind === 'OB' ? 'order block' : 'fair value gap';
  return `${kind} at ${formatPrice(poi.bottom, instrument)}-${formatPrice(poi.top, instrument)}`;
}

module.exports = { computeBias };
