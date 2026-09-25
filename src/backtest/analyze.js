'use strict';

const { summarize, bucketBy } = require('./stats');
const { CHECK_IDS } = require('../scoring/checks');

const BIAS_ORDER = ['weak', 'moderate', 'strong'];

const DEFAULTS = {
  // No rule is ever derived from fewer trades than this.
  minSamples: 30,
  // Fraction of the (chronological) history used to CHOOSE the rules. The rest
  // is never looked at during selection and only validates the result.
  trainRatio: 0.7,
  // A confirmation must add at least this much expected R to be made mandatory.
  requireImprovement: 0.05,
  // Out-of-sample trades needed before the holdout can validate anything.
  minTestSamples: 20,
  // Hard cap on mandatory confirmations. Each extra rule is another chance to
  // fit noise, and there are 64 possible subsets of six checks.
  maxRequiredConfirmations: 2,
};

/** Every bucketing we report on, for the human-readable part of the run. */
function analyzeDimensions(trades) {
  return {
    overall: summarize(trades),
    byScore: bucketBy(trades, (t) => t.score),
    byInstrument: bucketBy(trades, (t) => t.instrumentId),
    byDirection: bucketBy(trades, (t) => t.direction),
    byBiasStrength: bucketBy(trades, (t) => t.biasStrength),
    byPoiKind: bucketBy(trades, (t) => t.poiKind),
    byStatus: bucketBy(trades, (t) => t.status),
    byTargetCapped: bucketBy(trades, (t) => (t.targetCapped ? 'capped' : 'uncapped')),
    byConfirmation: CHECK_IDS.map((id) => {
      const withIt = trades.filter((t) => t.confirmations.includes(id));
      const withoutIt = trades.filter((t) => !t.confirmations.includes(id));
      return { key: id, with: summarize(withIt), without: summarize(withoutIt) };
    }).sort((a, b) => b.with.expectancyLower - a.with.expectancyLower),
    bySignature: bucketBy(trades, (t) => t.confirmationSignature),
  };
}

/** Does a trade satisfy a set of profile rules? */
/**
 * Does a feature list carry a token? A combined token "a & b" (two
 * conditions that occur together) needs every part.
 */
const COMBO = ' & ';
function hasFeature(features, token) {
  if (!features) return false;
  if (!token.includes(COMBO)) return features.includes(token);
  return token.split(COMBO).every((part) => features.includes(part));
}

function matchesRules(trade, rules) {
  if (rules.minScore && trade.score < rules.minScore) return false;
  if (rules.disabledInstruments && rules.disabledInstruments.includes(trade.instrumentId)) return false;
  if (rules.allowedDirections && !rules.allowedDirections.includes(trade.direction)) return false;
  if (rules.minBiasStrength) {
    const want = BIAS_ORDER.indexOf(rules.minBiasStrength);
    const got = BIAS_ORDER.indexOf(trade.biasStrength);
    if (want >= 0 && got < want) return false;
  }
  for (const id of rules.requiredConfirmations || []) {
    if (!trade.confirmations.includes(id)) return false;
  }
  // Learned chart-pattern and context features.
  const features = trade.features || [];
  for (const f of rules.requiredFeatures || []) {
    if (!hasFeature(features, f)) return false;
  }
  for (const f of rules.excludedFeatures || []) {
    if (hasFeature(features, f)) return false;
  }
  return true;
}

const applyRules = (trades, rules) => trades.filter((t) => matchesRules(t, rules));

/**
 * Derive the highest-probability rule set from a backtest.
 *
 * Selection happens ONLY on the chronologically earlier `trainRatio` of the
 * trades. The remainder is held back and used once, at the end, to check that
 * the chosen rules still work on data they were not fitted to. A profile whose
 * out-of-sample expectancy is not positive is returned with
 * `validated: false` — it is evidence of overfitting, not a green light.
 */
function selectProfile(trades, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const notes = [];
  const ordered = [...trades].sort((a, b) => a.time - b.time);

  const splitAt = Math.floor(ordered.length * cfg.trainRatio);
  const train = ordered.slice(0, splitAt);
  const test = ordered.slice(splitAt);

  const rules = {
    minScore: null,
    requiredConfirmations: [],
    minBiasStrength: null,
    disabledInstruments: [],
    allowedDirections: null,
  };

  if (train.length < cfg.minSamples) {
    notes.push(
      `Only ${train.length} training trades — fewer than the ${cfg.minSamples} minimum, so no rules were derived.`
    );
    return finish({ rules, train, test, ordered, cfg, notes, insufficient: true });
  }

  // ---- 1. minimum confirmation score -------------------------------------
  let best = null;
  let bestAny = null;
  for (let s = 3; s <= 6; s += 1) {
    const subset = train.filter((t) => t.score >= s);
    const stats = summarize(subset);
    if (stats.n < cfg.minSamples) continue;
    if (!bestAny || stats.expectancyLower > bestAny.stats.expectancyLower) bestAny = { score: s, stats };
    // A threshold only qualifies when even the pessimistic end of its interval
    // is positive. Picking the least-bad of several losing buckets is how a
    // profile gets built on noise.
    if (stats.expectancyLower <= 0) continue;
    // Ties go to the HIGHER threshold. When two thresholds select the same
    // historical trades (because no setup ever scored in between), the lower
    // one would also admit a class of setup the backtest never measured.
    if (!best || stats.expectancyLower >= best.stats.expectancyLower) best = { score: s, stats };
  }
  if (!best) {
    notes.push(
      bestAny
        ? `No score threshold showed edge: the best was score >= ${bestAny.score} at ${fmtR(
            bestAny.stats.expectancy
          )} (lower bound ${fmtR(bestAny.stats.expectancyLower)}, not above zero).`
        : `No score threshold had ${cfg.minSamples}+ training trades.`
    );
    return finish({ rules, train, test, ordered, cfg, notes, insufficient: true });
  }
  rules.minScore = best.score;
  notes.push(
    `Score >= ${best.score} chosen: ${best.stats.n} training trades, expectancy ${fmtR(
      best.stats.expectancy
    )} (95% lower bound ${fmtR(best.stats.expectancyLower)}).`
  );

  // ---- 2. mandatory confirmations ----------------------------------------
  let pool = applyRules(train, rules);
  let baseline = summarize(pool);

  for (let round = 0; round < cfg.maxRequiredConfirmations; round += 1) {
    let candidate = null;
    for (const id of CHECK_IDS) {
      if (rules.requiredConfirmations.includes(id)) continue;
      const subset = pool.filter((t) => t.confirmations.includes(id));
      const stats = summarize(subset);
      if (stats.n < cfg.minSamples) continue;
      const gain = stats.expectancyLower - baseline.expectancyLower;
      if (gain < cfg.requireImprovement) continue;
      // The improvement must arrive at a bucket that is itself positive at the
      // lower bound — "less negative than before" is not an edge.
      if (stats.expectancyLower <= 0) continue;
      if (!candidate || gain > candidate.gain) candidate = { id, stats, gain };
    }
    if (!candidate) break;

    rules.requiredConfirmations.push(candidate.id);
    notes.push(
      `Requiring "${candidate.id}" raised the training lower bound by ${fmtR(candidate.gain)} on ${
        candidate.stats.n
      } trades.`
    );
    pool = applyRules(train, rules);
    baseline = summarize(pool);
  }

  // ---- 3. bias strength floor --------------------------------------------
  const weak = pool.filter((t) => t.biasStrength === 'weak');
  const weakStats = summarize(weak);
  if (weakStats.n >= cfg.minSamples && weakStats.expectancyUpper < 0) {
    rules.minBiasStrength = 'moderate';
    notes.push(
      `Weak-bias setups were clearly negative (${weakStats.n} trades, expectancy ${fmtR(
        weakStats.expectancy
      )}), so a moderate bias is now required.`
    );
    pool = applyRules(train, rules);
  }

  // ---- 4. instruments with no edge ---------------------------------------
  for (const bucket of bucketBy(pool, (t) => t.instrumentId)) {
    if (bucket.n >= cfg.minSamples && bucket.expectancyUpper < 0) {
      rules.disabledInstruments.push(bucket.key);
      notes.push(
        `${bucket.key} disabled: ${bucket.n} trades, expectancy ${fmtR(bucket.expectancy)}, upper bound still negative.`
      );
    }
  }

  return finish({ rules, train, test, ordered, cfg, notes });
}

function finish({ rules, train, test, ordered, cfg, notes, insufficient = false }) {
  const trainStats = summarize(applyRules(train, rules));
  const testStats = summarize(applyRules(test, rules));
  const unfilteredTest = summarize(test);

  let validated = false;
  const minTest = cfg.minTestSamples || 20;

  if (insufficient) {
    notes.push('Profile not validated — no rules were derived.');
  } else if (testStats.n < minTest) {
    notes.push(
      `Only ${testStats.n} out-of-sample trades survived the rules — ${minTest} are needed to validate anything.`
    );
  } else if (testStats.expectancyLower <= 0) {
    // A point estimate on a small holdout is noise. The interval has to clear
    // zero on data the rules were never fitted to.
    notes.push(
      `Out-of-sample check FAILED: ${testStats.n} held-back trades at ${fmtR(
        testStats.expectancy
      )}, but the lower bound is ${fmtR(testStats.expectancyLower)} — indistinguishable from luck.`
    );
  } else if (testStats.expectancy <= unfilteredTest.expectancy) {
    // The filter has to beat doing nothing over the SAME period; a holdout
    // that was simply kind to every setup proves nothing about the rules.
    notes.push(
      `Out-of-sample check FAILED: filtered ${fmtR(testStats.expectancy)} did not beat unfiltered ${fmtR(
        unfilteredTest.expectancy
      )} over the same period.`
    );
  } else {
    validated = true;
    notes.push(
      `Out-of-sample check passed: ${testStats.n} held-back trades, expectancy ${fmtR(
        testStats.expectancy
      )} (lower bound ${fmtR(testStats.expectancyLower)}) vs ${fmtR(unfilteredTest.expectancy)} unfiltered.`
    );
  }

  return {
    rules,
    validated,
    insufficient,
    notes,
    split: { trainTrades: train.length, testTrades: test.length, trainRatio: cfg.trainRatio },
    train: trainStats,
    test: testStats,
    unfilteredTest,
    unfilteredAll: summarize(ordered),
    filteredAll: summarize(applyRules(ordered, rules)),
  };
}

const fmtR = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(3)}R`;

module.exports = {
  hasFeature,
  COMBO, analyzeDimensions, selectProfile, matchesRules, applyRules, CHECK_IDS, BIAS_ORDER, ANALYZE_DEFAULTS: DEFAULTS };
