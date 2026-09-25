'use strict';

const config = require('../config');
const { mean, stdev } = require('../backtest/stats');
const { BASELINE, parseKey, describeAdjust } = require('./planVariants');

const Z_95 = 1.959964;

/**
 * Learn where stops and targets should go, per market group.
 *
 * Every trade carrying `variants` (its R under each alternative placement,
 * see planVariants.js) is a paired comparison: same setup, same candles,
 * different placement. For each group — volatility indices, jump indices,
 * forex, and all of them together — the trades are split in time:
 *
 *   train  pick the variant whose improvement over the current placement has
 *          the best average, among those whose 95% lower bound is above zero
 *   test   adopt it only if it beats the current placement on the LATER
 *          trades too, again with the lower bound above zero
 *
 * A group that does not clear both keeps the default placement. Nothing is
 * adopted on a hunch.
 */
const GROUP_LABELS = { synthetic: 'Volatility indices', jump: 'Jump indices', forex: 'Forex' };

function groupOf(t) {
  const inst = config.instrumentById(t.instrumentId);
  if (inst) return inst.subKind || inst.kind;
  return t.subKind || t.instrumentKind || 'other';
}

function pairedStats(trades, key, base) {
  const d = trades.map((t) => t.variants[key] - t.variants[base]);
  const n = d.length;
  const m = mean(d);
  const se = n > 1 ? stdev(d) / Math.sqrt(n) : Infinity;
  return { n, meanDiff: m, lower: m - Z_95 * se };
}

function learnPlan(trades, cfg = {}) {
  const minSamples = cfg.minSamples || 30;
  const minTest = cfg.minTestSamples || minSamples;
  const trainRatio = cfg.trainRatio || 0.7;
  const base = BASELINE();

  const usable = trades
    .filter((t) => t.variants && Number.isFinite(t.variants[base]))
    .sort((a, b) => a.time - b.time);

  const groups = { all: usable };
  for (const t of usable) {
    const g = groupOf(t);
    (groups[g] = groups[g] || []).push(t);
  }

  const byGroup = {};
  const notes = [];

  for (const [group, list] of Object.entries(groups)) {
    const label = group === 'all' ? 'All pairs' : GROUP_LABELS[group] || group;
    if (list.length < minSamples + minTest) {
      notes.push(`${label}: ${list.length} trades with placement data — ${minSamples + minTest} needed before testing stop/target changes.`);
      continue;
    }
    const splitAt = Math.floor(list.length * trainRatio);
    const train = list.slice(0, splitAt);
    const test = list.slice(splitAt);
    const keys = Object.keys(list[0].variants).filter((k) => k !== base && list.every((t) => Number.isFinite(t.variants[k])));

    let best = null;
    for (const key of keys) {
      const s = pairedStats(train, key, base);
      if (s.lower <= 0) continue;
      if (!best || s.meanDiff > best.train.meanDiff) best = { key, train: s };
    }
    if (!best) {
      notes.push(`${label}: no alternative stop/target placement beat the current one on ${train.length} trades — keeping it.`);
      continue;
    }

    const t = pairedStats(test, best.key, base);
    const adj = parseKey(best.key);
    if (test.length < minTest || t.lower <= 0) {
      notes.push(
        `${label}: ${describeAdjust(adj)} looked better on earlier trades (+${best.train.meanDiff.toFixed(2)}R) ` +
          `but not on the ${test.length} later ones (${t.meanDiff >= 0 ? '+' : ''}${t.meanDiff.toFixed(2)}R) — not adopted.`
      );
      continue;
    }

    byGroup[group] = {
      ...adj,
      key: best.key,
      label,
      trades: list.length,
      improvement: Number(t.meanDiff.toFixed(4)),
      improvementLower: Number(t.lower.toFixed(4)),
      testTrades: t.n,
      baselineR: Number(mean(test.map((x) => x.variants[base])).toFixed(4)),
      adjustedR: Number(mean(test.map((x) => x.variants[best.key])).toFixed(4)),
    };
    notes.push(
      `${label}: ADOPTED ${describeAdjust(adj)} — on ${t.n} later trades it averaged ` +
        `${byGroup[group].adjustedR.toFixed(2)}R vs ${byGroup[group].baselineR.toFixed(2)}R with the current placement.`
    );
  }

  return { baseline: base, byGroup, notes, trades: usable.length };
}

/** The adjustment to use for an instrument: its own group's, else the all-pairs one. */
function adjustmentFor(plan, instrumentId) {
  if (!plan || !plan.byGroup) return null;
  const group = groupOf({ instrumentId });
  return plan.byGroup[group] || plan.byGroup.all || null;
}

module.exports = { learnPlan, adjustmentFor, groupOf, GROUP_LABELS };
