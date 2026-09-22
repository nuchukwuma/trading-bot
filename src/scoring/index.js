'use strict';

const config = require('../config');
const poiLib = require('../poi');
const { analyzeStructure } = require('../structure/marketStructure');
const { dealingRange } = require('../structure/range');
const { CHECKS } = require('./checks');

/**
 * Confirmation scorer.
 *
 * Runs the six checks against a 30m series given a 4H bias, and reports how
 * many fired with the one-line reason for each. `passed` is true only when the
 * count reaches `minConfirmations` (3 of 6 by default) — the trade-plan module
 * applies the separate R:R gate on top of that.
 */
function scoreSetup(input) {
  const opts = input.opts || {};
  const cfg = { ...config.scoring, ...(opts.scoring || {}) };
  const bias = input.bias;
  const ltfCandles = input.ltfCandles;

  if (!bias || bias.direction === 'neutral') {
    return {
      direction: 'neutral',
      score: 0,
      required: cfg.minConfirmations,
      passed: false,
      confirmations: [],
      fired: [],
      reason: 'No HTF bias — nothing to confirm',
    };
  }

  const ltfStructure = input.ltfStructure || analyzeStructure(ltfCandles, opts.structure || {});
  const ltfPois =
    input.ltfPois ||
    poiLib.buildPOIs(ltfCandles, { timeframe: config.timeframes.ltf, ...(opts.poi || {}) });

  const price = Number.isFinite(input.price) ? input.price : ltfCandles[ltfCandles.length - 1].close;

  // The zone the trade would be entered from: the POI price is currently in,
  // otherwise the nearest live POI in the direction of bias.
  const entryPoi =
    poiLib.poisContaining(ltfPois, price, bias.direction)[0] ||
    poiLib.nearestUnmitigated(ltfPois, price, bias.direction) ||
    null;

  const entryZone = entryPoi ? { top: entryPoi.top, bottom: entryPoi.bottom } : null;
  // Entry is the zone edge price meets first, but never a stale level that
  // price has already traded through — in that case the market price is both
  // achievable and strictly better, so it wins.
  const entryPrice = entryPoi ? achievableEntry(poiLib.proximalEdge(entryPoi), price, bias.direction) : price;

  const ltfRange = dealingRange(
    ltfCandles,
    ltfStructure.lastEvent ? { leg: ltfStructure.lastEvent.leg, ...(opts.premiumDiscount || {}) } : opts.premiumDiscount || {}
  );

  const ctx = {
    instrument: input.instrument,
    bias,
    ltfCandles,
    ltfStructure,
    ltfPois,
    price,
    entryPoi,
    entryZone,
    entryPrice,
    ltfRange,
    opts,
  };

  const confirmations = CHECKS.map((fn) => fn(ctx));
  const fired = confirmations.filter((c) => c.passed);

  return {
    direction: bias.direction,
    score: fired.length,
    required: cfg.minConfirmations,
    total: cfg.totalChecks,
    passed: fired.length >= cfg.minConfirmations,
    confirmations,
    fired,
    reasons: fired.map((c) => c.reason),
    entryPoi,
    entryZone,
    entryPrice,
    ltfStructure,
    ltfPois,
    ltfRange,
    price,
  };
}

/** Longs never pay above the zone edge; shorts never sell below it. */
function achievableEntry(edge, price, direction) {
  return direction === 'bullish' ? Math.min(edge, price) : Math.max(edge, price);
}

module.exports = { scoreSetup, achievableEntry, ...require('./checks') };
