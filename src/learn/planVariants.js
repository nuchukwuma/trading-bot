'use strict';

const config = require('../config');
const { buildTargets } = require('../tradeplan/targets');
const { simulateTrade } = require('../backtest/simulator');

/**
 * Alternative stop and target placements, replayed on the same candles.
 *
 * Every setup the bot resolves is also re-traded under a small grid of other
 * placements — the stop nearer or further from the entry, TP1 at a larger R
 * with TP2/TP3 moved in proportion — so the learner can ask whether a
 * different placement would have paid better on exactly the same setups.
 *
 * Kept deliberately small (4 x 3 = 12 variants): every extra variant is
 * another chance for noise to look like an improvement.
 *
 * Everything else is held fixed:
 *   - the entry, so fills are comparable
 *   - the dollar risk, so R is comparable across stop distances
 *   - the liquidity cap on targets and the hard 1:2 gate on TP1 — a variant
 *     the live bot would have rejected scores 0R (no trade)
 */
const STOP_SCALES = [0.75, 1, 1.25, 1.5];

function tp1Choices() {
  const base = config.tradePlan.targets[0].rr;
  return [...new Set([base, 2, 2.5, 3])]
    .filter((r) => r + 1e-9 >= config.tradePlan.minRiskReward)
    .sort((a, b) => a - b);
}

const keyOf = (stopScale, tp1R) => `s${stopScale}_t${tp1R}`;
const BASELINE = () => keyOf(1, config.tradePlan.targets[0].rr);

function parseKey(key) {
  const m = /^s([\d.]+)_t([\d.]+)$/.exec(key);
  return m ? { stopScale: Number(m[1]), tp1R: Number(m[2]) } : null;
}

/** The configured ladder with TP1 moved to `tp1R` and the rest scaled with it. */
function scaledLadder(tp1R, base = config.tradePlan.targets) {
  const k = tp1R / base[0].rr;
  return base.map((t) => ({ ...t, rr: t.rr * k }));
}

function variantPlan({ direction, entryPrice, baseRisk, obstacle, stopScale, tp1R }) {
  const riskDistance = baseRisk * stopScale;
  const stopPrice = direction === 'bullish' ? entryPrice - riskDistance : entryPrice + riskDistance;
  const targets = buildTargets({ direction, entryPrice, riskDistance, obstacle, targets: scaledLadder(tp1R) });
  if (targets[0].rr + 1e-9 < config.tradePlan.minRiskReward) return null;
  return { direction, entryPrice, stopPrice, riskDistance, targets };
}

/**
 * @param {object} p
 * @param {Array}  p.candles  candles AFTER the signal, at least a full review window
 * @returns {Object<string, number>} R per variant key (0 = no trade)
 */
function computeVariants({ direction, entryPrice, baseRisk, obstacle = null, candles, signalClose, simOpts = {} }) {
  const out = {};
  if (!(baseRisk > 0) || !Number.isFinite(entryPrice)) return out;
  for (const stopScale of STOP_SCALES) {
    for (const tp1R of tp1Choices()) {
      const plan = variantPlan({ direction, entryPrice, baseRisk, obstacle, stopScale, tp1R });
      if (!plan) {
        out[keyOf(stopScale, tp1R)] = 0;
        continue;
      }
      const o = simulateTrade({ plan, candles, signalClose, opts: simOpts });
      out[keyOf(stopScale, tp1R)] = o.filled ? Number(o.rMultiple.toFixed(4)) : 0;
    }
  }
  return out;
}

/** Describe an adjustment in plain words. */
function describeAdjust(adj) {
  const bits = [];
  if (adj.stopScale !== 1) {
    const pct = Math.round((adj.stopScale - 1) * 100);
    bits.push(`stop ${pct > 0 ? `${pct}% wider` : `${-pct}% tighter`}`);
  }
  if (adj.tp1R !== config.tradePlan.targets[0].rr) bits.push(`TP1 at ${adj.tp1R}R (TP2/TP3 moved with it)`);
  return bits.join(', ') || 'default placement';
}

module.exports = {
  STOP_SCALES,
  tp1Choices,
  keyOf,
  parseKey,
  BASELINE,
  scaledLadder,
  variantPlan,
  computeVariants,
  describeAdjust,
};
