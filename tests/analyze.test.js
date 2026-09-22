'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { selectProfile, matchesRules, applyRules, analyzeDimensions } = require('../src/backtest/analyze');
const { summarize, wilsonLowerBound } = require('../src/backtest/stats');
const { mulberry32 } = require('../src/backtest/randomWalk');

let clock = 1700000000;
const trade = (o = {}) => ({
  instrumentId: 'X',
  instrumentKind: 'synthetic',
  time: (clock += 1800),
  score: 4,
  confirmations: ['ltf_structure', 'poi_retrace'],
  confirmationSignature: 'ltf_structure+poi_retrace',
  direction: 'bullish',
  biasStrength: 'moderate',
  poiKind: 'OB',
  targetCapped: false,
  filled: true,
  status: 'tp1',
  rMultiple: 0,
  barsHeld: 10,
  mfe: 1,
  mae: -0.5,
  ...o,
});

/** `n` trades where `winRate` of them pay `win` R and the rest lose 1R. */
function cohort(n, winRate, win, extra = {}) {
  const rand = mulberry32(42);
  return Array.from({ length: n }, () => {
    const isWin = rand() < winRate;
    return trade({ rMultiple: isWin ? win : -1, status: isWin ? 'tp1' : 'stopped', ...extra });
  });
}

/** Interleave cohorts so train and test periods both contain every kind. */
function interleave(...groups) {
  const out = [];
  const max = Math.max(...groups.map((g) => g.length));
  for (let i = 0; i < max; i += 1) for (const g of groups) if (g[i]) out.push(g[i]);
  return out.map((t, i) => ({ ...t, time: 1700000000 + i * 1800 }));
}

test('rules: matching covers every rule kind', () => {
  const t = trade({ score: 4, confirmations: ['a', 'b'], biasStrength: 'moderate', instrumentId: 'VOL75' });

  assert.equal(matchesRules(t, { minScore: 4 }), true);
  assert.equal(matchesRules(t, { minScore: 5 }), false);
  assert.equal(matchesRules(t, { requiredConfirmations: ['a'] }), true);
  assert.equal(matchesRules(t, { requiredConfirmations: ['a', 'z'] }), false);
  assert.equal(matchesRules(t, { disabledInstruments: ['VOL75'] }), false);
  assert.equal(matchesRules(t, { disabledInstruments: ['EURUSD'] }), true);
  assert.equal(matchesRules(t, { allowedDirections: ['bearish'] }), false);
  assert.equal(matchesRules(t, { minBiasStrength: 'moderate' }), true);
  assert.equal(matchesRules(t, { minBiasStrength: 'strong' }), false);
  assert.equal(matchesRules(trade({ biasStrength: 'strong' }), { minBiasStrength: 'moderate' }), true);
  assert.equal(matchesRules(t, {}), true, 'an empty rule set passes everything');
});

test('selector: refuses to invent a rule from too few trades', () => {
  const result = selectProfile(cohort(20, 0.9, 3), { minSamples: 30 });
  assert.equal(result.insufficient, true);
  assert.equal(result.validated, false);
  assert.equal(result.rules.minScore, null);
  assert.match(result.notes[0], /fewer than the 30 minimum/);
});

test('selector: finds nothing in data with no edge', () => {
  // 40% win rate at +2R against -1R is break-even by construction.
  const noise = cohort(300, 0.333, 2);
  const result = selectProfile(noise, { minSamples: 30 });

  assert.equal(result.validated, false);
  assert.equal(result.rules.minScore, null);
  assert.deepEqual(result.rules.requiredConfirmations, []);
  assert.match(result.notes[0], /No score threshold showed edge/);
});

test('selector: a losing bucket is never chosen just for being the least bad', () => {
  const losers = cohort(300, 0.2, 2); // expectancy about -0.4R
  const result = selectProfile(losers, { minSamples: 30 });
  assert.equal(result.rules.minScore, null, 'no threshold may be selected from a set of losers');
  assert.equal(result.validated, false);
});

test('selector: picks the score threshold that actually carries the edge', () => {
  const good = cohort(200, 0.7, 2, { score: 5 });
  const bad = cohort(150, 0.15, 2, { score: 3 });
  const result = selectProfile(interleave(good, bad), { minSamples: 30 });

  assert.equal(result.rules.minScore, 5);
  assert.ok(result.train.expectancy > 0.5);
  assert.equal(result.validated, true);
  assert.match(result.notes[0], /Score >= 5 chosen/);
});

test('selector: ties break toward the stricter threshold', () => {
  // No trade ever scored 4, so "score >= 4" and "score >= 5" pick out exactly
  // the same history. Choosing 4 would admit untested score-4 setups live.
  const good = cohort(200, 0.7, 2, { score: 5 });
  const bad = cohort(150, 0.15, 2, { score: 3 });
  const result = selectProfile(interleave(good, bad), { minSamples: 30 });

  assert.equal(result.rules.minScore, 5);
  assert.equal(
    result.filteredAll.n,
    interleave(good, bad).filter((t) => t.score >= 5).length,
    'the filter admits exactly the measured cohort'
  );
});

test('selector: makes a confirmation mandatory when it carries the edge', () => {
  const withSweep = cohort(200, 0.85, 2, {
    score: 5,
    confirmations: ['ltf_structure', 'liquidity_sweep'],
  });
  const withoutSweep = cohort(200, 0.3, 2, { score: 5, confirmations: ['ltf_structure'] });
  const result = selectProfile(interleave(withSweep, withoutSweep), { minSamples: 30 });

  assert.ok(result.rules.requiredConfirmations.includes('liquidity_sweep'));
  assert.ok(result.test.expectancy > result.unfilteredTest.expectancy);
});

test('selector: caps how many confirmations it may demand', () => {
  const rich = cohort(400, 0.9, 2, {
    score: 6,
    confirmations: ['ltf_structure', 'liquidity_sweep', 'poi_retrace', 'displacement'],
  });
  const poor = cohort(400, 0.2, 2, { score: 6, confirmations: ['ltf_structure'] });
  const result = selectProfile(interleave(rich, poor), { minSamples: 30, maxRequiredConfirmations: 2 });
  assert.ok(result.rules.requiredConfirmations.length <= 2, 'each extra rule is another chance to fit noise');
});

test('selector: disables an instrument with clearly negative expectancy', () => {
  const good = cohort(200, 0.75, 2, { score: 5, instrumentId: 'VOL75' });
  const bad = cohort(120, 0.05, 2, { score: 5, instrumentId: 'JUMP100' });
  const result = selectProfile(interleave(good, bad), { minSamples: 30 });

  assert.ok(result.rules.disabledInstruments.includes('JUMP100'));
  assert.ok(!result.rules.disabledInstruments.includes('VOL75'));
});

test('selector: requires a moderate bias when weak-bias trades clearly lose', () => {
  const strong = cohort(200, 0.8, 2, { score: 5, biasStrength: 'strong' });
  const weak = cohort(120, 0.05, 2, { score: 5, biasStrength: 'weak' });
  const result = selectProfile(interleave(strong, weak), { minSamples: 30 });
  assert.equal(result.rules.minBiasStrength, 'moderate');
});

test('selector: a holdout too small to judge does not validate', () => {
  const good = cohort(60, 0.8, 2, { score: 5 });
  const result = selectProfile(good, { minSamples: 30, minTestSamples: 20 });
  assert.equal(result.validated, false);
  assert.match(result.notes[result.notes.length - 1], /are needed to validate/);
});

test('selector: a holdout that only looks good by luck does not validate', () => {
  // Strong in the training period, then pure noise afterwards.
  const train = cohort(120, 0.85, 2, { score: 5 });
  const test = cohort(80, 0.33, 2, { score: 5 });
  const chronological = [...train, ...test].map((t, i) => ({ ...t, time: 1700000000 + i * 1800 }));

  const result = selectProfile(chronological, { minSamples: 30, trainRatio: 0.6 });
  assert.equal(result.validated, false);
  assert.match(result.notes[result.notes.length - 1], /FAILED/);
});

test('selector: a filter that does not beat doing nothing is rejected', () => {
  // Every trade is identical, so any rule is cosmetic: filtered can never beat
  // unfiltered, and the profile must not claim a win.
  const uniform = Array.from({ length: 300 }, (_, i) =>
    trade({ score: 5, rMultiple: i % 3 === 0 ? -1 : 1, time: 1700000000 + i * 1800 })
  );
  const result = selectProfile(uniform, { minSamples: 30 });
  if (result.rules.minScore !== null) {
    assert.ok(
      result.validated === false || result.test.expectancy > result.unfilteredTest.expectancy,
      'a validated profile must beat the unfiltered holdout'
    );
  }
});

test('selector: applying the rules reproduces the reported filtered set', () => {
  const good = cohort(200, 0.75, 2, { score: 5 });
  const bad = cohort(150, 0.15, 2, { score: 3 });
  const all = interleave(good, bad);
  const result = selectProfile(all, { minSamples: 30 });

  const recomputed = summarize(applyRules(all, result.rules));
  assert.equal(recomputed.n, result.filteredAll.n);
  assert.ok(Math.abs(recomputed.expectancy - result.filteredAll.expectancy) < 1e-9);
});

test('analysis: every reporting dimension is produced', () => {
  const trades = interleave(cohort(60, 0.7, 2, { score: 5 }), cohort(60, 0.2, 2, { score: 3 }));
  const dims = analyzeDimensions(trades);

  assert.equal(dims.overall.n, 120);
  assert.deepEqual(dims.byScore.map((b) => b.key).sort(), ['3', '5']);
  assert.equal(dims.byConfirmation.length, 6, 'one row per check');
  for (const c of dims.byConfirmation) {
    assert.equal(c.with.n + c.without.n, 120, `${c.key} splits the whole sample`);
  }
  assert.ok(dims.byInstrument.length >= 1);
  assert.ok(dims.byStatus.length >= 1);
});

test('stats: the lower bound punishes small samples, as the selector depends on', () => {
  assert.ok(wilsonLowerBound(7, 10) < 0.45, '70% on 10 trades carries little information');
  assert.ok(wilsonLowerBound(700, 1000) > 0.66, '70% on 1000 trades is solid');
  assert.ok(wilsonLowerBound(70, 100) > wilsonLowerBound(7, 10));

  const small = summarize(cohort(5, 1, 2));
  assert.ok(small.expectancyLower <= small.expectancy);
});
