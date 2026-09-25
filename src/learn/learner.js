'use strict';

const { summarize, welchTest, benjaminiHochberg } = require('../backtest/stats');
const { matchesRules, applyRules } = require('../backtest/analyze');
const { learnPlan } = require('./planLearner');

const DEFAULTS = {
  minSamples: 30,
  trainRatio: 0.7,
  minTestSamples: 20,
  // Tolerated false discovery rate across every feature tested in a run.
  fdr: 0.1,
  // One feature rule earned per this many trades. This is what makes alerts
  // narrow AS the sample grows, instead of all at once on thin evidence.
  tradesPerRule: 100,
  maxFeatureRules: 4,
  // A rule must move the pooled lower bound by at least this much.
  minImprovement: 0.05,
};

const BIAS_ORDER = ['weak', 'moderate', 'strong'];

/**
 * The learner.
 *
 * Given every resolved trade it has ever seen — backtested and live — it
 * searches the feature space for what actually paid, and emits the rule set
 * the scanner filters on.
 *
 * Two properties matter more than the search itself:
 *
 *  - It tests dozens of candidate features at once, so raw p-values are
 *    worthless. Benjamini-Hochberg controls the false discovery rate across
 *    the whole run.
 *  - Its selectivity is tied to sample size. Under `tradesPerRule` trades it
 *    may use no feature rules at all, however tempting the data looks. The
 *    filter tightens as evidence accumulates, not before.
 */
function learn(trades, opts = {}) {
  const result = learnRules(trades, opts);
  // Where the stop and targets go is learned alongside which setups to take.
  result.plan = learnPlan(trades, { ...DEFAULTS, ...opts });
  result.notes = [...result.notes, ...result.plan.notes];
  return result;
}

function learnRules(trades, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const notes = [];
  const ordered = [...trades].filter((t) => t.filled).sort((a, b) => a.time - b.time);

  const rules = {
    minScore: null,
    requiredConfirmations: [],
    requiredFeatures: [],
    excludedFeatures: [],
    minBiasStrength: null,
    disabledInstruments: [],
    allowedDirections: null,
  };

  const budget = ruleBudget(ordered.length, cfg);
  const growth = {
    trades: ordered.length,
    featureRuleBudget: budget,
    featureRulesUsed: 0,
    nextRuleAt: (budget + 1) * cfg.tradesPerRule,
  };

  if (ordered.length < cfg.minSamples) {
    notes.push(
      `${ordered.length} resolved trades — under the ${cfg.minSamples} minimum, so nothing is filtered yet.`
    );
    return finish({ rules, ordered, cfg, notes, growth, candidates: [], insufficient: true });
  }

  const splitAt = Math.floor(ordered.length * cfg.trainRatio);
  const train = ordered.slice(0, splitAt);
  const test = ordered.slice(splitAt);

  // ---- 1. score threshold (ordinal, so handled on its own) ----------------
  let best = null;
  for (let s = 3; s <= 6; s += 1) {
    const stats = summarize(train.filter((t) => t.score >= s));
    if (stats.n < cfg.minSamples || stats.expectancyLower <= 0) continue;
    if (!best || stats.expectancyLower >= best.stats.expectancyLower) best = { score: s, stats };
  }
  if (best) {
    rules.minScore = best.score;
    notes.push(
      `Score >= ${best.score}: ${best.stats.n} training trades, expectancy ${fmtR(
        best.stats.expectancy
      )} (lower bound ${fmtR(best.stats.expectancyLower)}).`
    );
  } else {
    notes.push('No confirmation-score threshold showed edge on its own.');
  }

  // ---- 2. feature search --------------------------------------------------
  // Features are SCREENED on the whole training set, not on what survives the
  // score threshold. Screening inside the narrowed pool throws away most of the
  // statistical power: a score rule can easily cut the sample by 80%, leaving
  // too few trades for any feature to be testable at all. Interaction between
  // rules is handled instead by re-measuring each candidate inside the current
  // pool before it is adopted.
  let pool = applyRules(train, rules);
  const candidates = testFeatures(train, cfg);

  const significant = candidates.filter((c) => c.significant);
  notes.push(
    `Tested ${candidates.length} features; ${significant.length} survived false-discovery control at q=${cfg.fdr}.`
  );

  if (pool.length < cfg.minSamples * 2 && budget > 0) {
    notes.push(
      `Only ${pool.length} training trades survive the score rule — too few to add a feature rule on top of it.`
    );
  }

  if (budget === 0) {
    notes.push(
      `No feature rules yet: ${ordered.length} trades earns a budget of 0 (one per ${cfg.tradesPerRule}). ` +
        `${growth.nextRuleAt - ordered.length} more resolved trades unlocks the first.`
    );
  }

  let baseline = summarize(pool);
  for (let round = 0; round < budget; round += 1) {
    const choice = pickBestRule(pool, significant, rules, baseline, cfg);
    if (!choice) break;

    if (choice.kind === 'require') rules.requiredFeatures.push(choice.feature);
    else rules.excludedFeatures.push(choice.feature);

    notes.push(
      `${choice.kind === 'require' ? 'Requiring' : 'Excluding'} "${choice.feature}" moved the training lower bound ` +
        `${fmtR(choice.gain)} to ${fmtR(choice.stats.expectancyLower)} on ${choice.stats.n} trades (p=${choice.p.toExponential(1)}).`
    );

    pool = applyRules(train, rules);
    baseline = summarize(pool);
    growth.featureRulesUsed += 1;
  }

  // ---- 3. instruments with no edge ---------------------------------------
  for (const id of [...new Set(pool.map((t) => t.instrumentId))]) {
    const stats = summarize(pool.filter((t) => t.instrumentId === id));
    if (stats.n >= cfg.minSamples && stats.expectancyUpper < 0) {
      rules.disabledInstruments.push(id);
      notes.push(`${id} disabled: ${stats.n} trades, expectancy ${fmtR(stats.expectancy)}, still negative at the upper bound.`);
    }
  }

  // ---- 4. bias strength floor --------------------------------------------
  const weakStats = summarize(applyRules(train, rules).filter((t) => t.biasStrength === 'weak'));
  if (weakStats.n >= cfg.minSamples && weakStats.expectancyUpper < 0) {
    rules.minBiasStrength = 'moderate';
    notes.push(`Weak-bias setups were clearly negative (${weakStats.n} trades) — a moderate bias is now required.`);
  }

  return finish({ rules, ordered, train, test, cfg, notes, growth, candidates });
}

/** How many feature rules the current sample size has earned. */
function ruleBudget(n, cfg) {
  return Math.max(0, Math.min(cfg.maxFeatureRules, Math.floor(n / cfg.tradesPerRule)));
}

/**
 * Test every feature token that appears often enough to be judged, then apply
 * false-discovery control across the whole batch at once.
 */
function testFeatures(pool, cfg) {
  const counts = new Map();
  for (const t of pool) for (const f of t.features || []) counts.set(f, (counts.get(f) || 0) + 1);

  const testable = [...counts.entries()].filter(
    // Both sides of the split must be big enough to compare.
    ([, n]) => n >= cfg.minSamples && pool.length - n >= cfg.minSamples
  );

  const results = testable.map(([feature]) => {
    const withIt = pool.filter((t) => (t.features || []).includes(feature));
    const withoutIt = pool.filter((t) => !(t.features || []).includes(feature));
    const test = welchTest(withIt.map((t) => t.rMultiple), withoutIt.map((t) => t.rMultiple));
    return {
      feature,
      p: test.p,
      diff: test.diff,
      with: summarize(withIt),
      without: summarize(withoutIt),
    };
  });

  const rejected = benjaminiHochberg(results.map((r) => r.p), cfg.fdr);
  results.forEach((r, i) => {
    r.significant = rejected[i];
  });

  return results.sort((a, b) => a.p - b.p);
}

/**
 * Best remaining rule, re-measured inside the CURRENT pool rather than trusted
 * from the first pass — a feature can stop helping once another rule is in.
 */
function pickBestRule(pool, significant, rules, baseline, cfg) {
  let best = null;

  for (const candidate of significant) {
    const { feature } = candidate;
    if (rules.requiredFeatures.includes(feature) || rules.excludedFeatures.includes(feature)) continue;

    const kind = candidate.diff > 0 ? 'require' : 'exclude';
    const subset =
      kind === 'require'
        ? pool.filter((t) => (t.features || []).includes(feature))
        : pool.filter((t) => !(t.features || []).includes(feature));

    const stats = summarize(subset);
    if (stats.n < cfg.minSamples) continue;
    if (stats.expectancyLower <= 0) continue;

    const gain = stats.expectancyLower - baseline.expectancyLower;
    if (gain < cfg.minImprovement) continue;

    if (!best || gain > best.gain) best = { feature, kind, stats, gain, p: candidate.p };
  }

  return best;
}

function finish({ rules, ordered, train = [], test = [], cfg, notes, growth, candidates, insufficient = false }) {
  const trainStats = summarize(applyRules(train, rules));
  const testStats = summarize(applyRules(test, rules));
  const unfilteredTest = summarize(test);
  const minTest = cfg.minTestSamples;

  let validated = false;
  if (insufficient) {
    notes.push('Nothing validated — the bot is still gathering data.');
  } else if (!rules.minScore && !rules.requiredFeatures.length && !rules.excludedFeatures.length) {
    notes.push('No rule cleared the evidence bar, so every setup that passes the structural gates still alerts.');
  } else if (testStats.n < minTest) {
    notes.push(`Only ${testStats.n} out-of-sample trades survived the rules — ${minTest} are needed to validate.`);
  } else if (testStats.expectancyLower <= 0) {
    notes.push(
      `Out-of-sample check FAILED: ${testStats.n} held-back trades at ${fmtR(testStats.expectancy)}, ` +
        `lower bound ${fmtR(testStats.expectancyLower)} — indistinguishable from luck.`
    );
  } else if (testStats.expectancy <= unfilteredTest.expectancy) {
    notes.push(
      `Out-of-sample check FAILED: filtered ${fmtR(testStats.expectancy)} did not beat unfiltered ${fmtR(
        unfilteredTest.expectancy
      )} over the same period.`
    );
  } else {
    validated = true;
    notes.push(
      `Out-of-sample check passed: ${testStats.n} held-back trades at ${fmtR(testStats.expectancy)} ` +
        `(lower bound ${fmtR(testStats.expectancyLower)}) vs ${fmtR(unfilteredTest.expectancy)} unfiltered.`
    );
  }

  return {
    rules,
    validated,
    insufficient,
    notes,
    growth,
    candidates,
    split: { trainTrades: train.length, testTrades: test.length },
    train: trainStats,
    test: testStats,
    unfilteredTest,
    unfilteredAll: summarize(ordered),
    filteredAll: summarize(applyRules(ordered, rules)),
  };
}

const fmtR = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(3)}R`;

module.exports = { learn, ruleBudget, testFeatures, matchesRules, LEARNER_DEFAULTS: DEFAULTS, BIAS_ORDER };
