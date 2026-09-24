'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { learn, ruleBudget } = require('../src/learn/learner');
const { welchTest, benjaminiHochberg, normalCdf } = require('../src/backtest/stats');
const { mulberry32 } = require('../src/backtest/randomWalk');
const ledger = require('../src/learn/ledger');
const { resolvePending, toPlan } = require('../src/learn/outcomeTracker');
const { LearningService } = require('../src/learn');
const { EdgeProfile } = require('../src/backtest/edgeProfile');

const NOISE_TOKENS = [
  'session:london', 'session:ny', 'session:asia', 'vol:high', 'vol:low', 'vol:normal',
  'dow:mon', 'dow:tue', 'dow:wed', 'pattern:inside_bar', 'pattern:pin_bar_bull',
  'pattern:engulfing_bull', 'shift:bos', 'shift:choch', 'rr:2.0-2.5', 'stop:wide',
  'poi:ob', 'poi:fvg', 'capped:yes', 'hour:08-12',
];

/**
 * A synthetic ledger. `signal` (when given) is a token that genuinely predicts;
 * every other token is sprinkled at random and predicts nothing.
 */
function makeTrades({ n, signal = null, signalRate = 0.4, goodWin = 0.75, baseWin = 0.3, seed = 9, score = 4 }) {
  const rand = mulberry32(seed);
  return Array.from({ length: n }, (_, i) => {
    const carries = signal && rand() < signalRate;
    const features = ['dir:bullish', 'instrument:X', `score:${score}`];
    if (carries) features.push(signal);
    for (const t of NOISE_TOKENS) if (rand() < 0.3) features.push(t);
    const win = rand() < (carries ? goodWin : baseWin);
    return {
      source: 'backtest',
      instrumentId: 'X',
      time: 1700000000 + i * 1800,
      score,
      confirmations: ['ltf_structure'],
      features: [...new Set(features)].sort(),
      direction: 'bullish',
      biasStrength: 'moderate',
      filled: true,
      status: win ? 'tp1' : 'stopped',
      rMultiple: win ? 2 : -1,
    };
  });
}

// ------------------------------------------------------------- growth budget
test('growth: the rule budget is earned, one per tradesPerRule', () => {
  const cfg = { tradesPerRule: 100, maxFeatureRules: 4 };
  assert.equal(ruleBudget(0, cfg), 0);
  assert.equal(ruleBudget(99, cfg), 0);
  assert.equal(ruleBudget(100, cfg), 1);
  assert.equal(ruleBudget(250, cfg), 2);
  assert.equal(ruleBudget(400, cfg), 4);
  assert.equal(ruleBudget(5000, cfg), 4, 'capped so it cannot keep narrowing forever');
});

test('growth: a strong signal is ignored until the sample earns a rule', () => {
  // Same generator, same edge — only the sample size differs.
  const small = learn(makeTrades({ n: 80, signal: 'pattern:double_bottom' }), { tradesPerRule: 100, minSamples: 20 });
  assert.equal(small.growth.featureRuleBudget, 0);
  assert.deepEqual(small.rules.requiredFeatures, [], 'no feature rule on 80 trades, however good it looks');
  assert.match(small.notes.join(' '), /more resolved trades unlocks the first/);

  const large = learn(makeTrades({ n: 600, signal: 'pattern:double_bottom' }), { tradesPerRule: 100, minSamples: 30 });
  assert.ok(large.growth.featureRuleBudget >= 4);
  assert.deepEqual(large.rules.requiredFeatures, ['pattern:double_bottom']);
});

test('growth: the report says how many more trades unlock the next rule', () => {
  const result = learn(makeTrades({ n: 150, signal: 'pattern:double_bottom' }), { tradesPerRule: 100, minSamples: 30 });
  assert.equal(result.growth.trades, 150);
  assert.equal(result.growth.featureRuleBudget, 1);
  assert.equal(result.growth.nextRuleAt, 200);
});

// ------------------------------------------------------------- the search
test('learner: finds the one real pattern and ignores twenty decoys', () => {
  const result = learn(makeTrades({ n: 600, signal: 'pattern:double_bottom' }), { minSamples: 30 });

  assert.deepEqual(result.rules.requiredFeatures, ['pattern:double_bottom']);
  assert.equal(result.rules.excludedFeatures.length, 0);
  assert.equal(result.validated, true);
  assert.ok(result.filteredAll.expectancy > result.unfilteredAll.expectancy + 0.5);
  assert.ok(result.test.expectancy > result.unfilteredTest.expectancy);
});

test('learner: learns to EXCLUDE a feature that predicts losses', () => {
  // The token marks bad trades, so the rule should be an exclusion.
  const result = learn(
    makeTrades({ n: 600, signal: 'pattern:inside_bar', goodWin: 0.05, baseWin: 0.6 }),
    { minSamples: 30 }
  );
  assert.ok(
    result.rules.excludedFeatures.includes('pattern:inside_bar') ||
      result.rules.requiredFeatures.length > 0,
    'a loss-predicting token is excluded rather than required'
  );
  assert.equal(result.rules.requiredFeatures.includes('pattern:inside_bar'), false);
});

test('learner: invents nothing when no feature predicts anything', () => {
  const result = learn(makeTrades({ n: 800, signal: null, baseWin: 0.34 }), { minSamples: 30 });
  assert.deepEqual(result.rules.requiredFeatures, []);
  assert.deepEqual(result.rules.excludedFeatures, []);
  assert.equal(result.validated, false);
});

test('learner: under the minimum sample it filters nothing at all', () => {
  const result = learn(makeTrades({ n: 15, signal: 'pattern:double_bottom' }), { minSamples: 30 });
  assert.equal(result.insufficient, true);
  assert.equal(result.rules.minScore, null);
  assert.deepEqual(result.rules.requiredFeatures, []);
  assert.match(result.notes[0], /under the 30 minimum/);
});

test('learner: every tested feature is reported with its p-value', () => {
  const result = learn(makeTrades({ n: 600, signal: 'pattern:double_bottom' }), { minSamples: 30 });
  assert.ok(result.candidates.length > 5);
  for (const cand of result.candidates) {
    assert.ok(cand.p >= 0 && cand.p <= 1);
    assert.equal(typeof cand.significant, 'boolean');
  }
  const winner = result.candidates.find((cand) => cand.feature === 'pattern:double_bottom');
  assert.equal(winner.significant, true);
  assert.ok(winner.p < 0.01);
});

// ------------------------------------------------------------- statistics
test('stats: Welch separates genuinely different groups and not identical ones', () => {
  const good = Array.from({ length: 80 }, (_, i) => (i % 4 ? 2 : -1));
  const bad = Array.from({ length: 80 }, (_, i) => (i % 4 ? -1 : 2));
  assert.ok(welchTest(good, bad).p < 0.001);
  assert.ok(welchTest(good, good.slice()).p > 0.9);
  assert.equal(welchTest([1], [2]).p, 1, 'too small to say anything');
  assert.equal(welchTest([1, 1, 1], [1, 1, 1]).p, 1, 'no variance, no signal');
});

test('stats: the normal CDF is accurate enough for p-values', () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(normalCdf(1.959964) - 0.975) < 1e-4);
  assert.ok(Math.abs(normalCdf(-2.575829) - 0.005) < 1e-4);
});

test('stats: false-discovery control rejects nothing from a field of nulls', () => {
  // 40 uniformly distributed p-values — what pure noise looks like.
  const nulls = Array.from({ length: 40 }, (_, i) => (i + 1) / 41);
  assert.equal(benjaminiHochberg(nulls, 0.1).filter(Boolean).length, 0);

  // A couple of genuinely tiny p-values do survive.
  const withSignal = [0.0001, 0.0002, ...nulls];
  assert.ok(benjaminiHochberg(withSignal, 0.1).filter(Boolean).length >= 2);

  assert.deepEqual(benjaminiHochberg([], 0.1), []);
});

test('stats: FDR is stricter than an uncorrected threshold', () => {
  // Twenty nulls, one of which lands under 0.05 by chance — exactly the case
  // that fills a profile with invented patterns.
  const pvals = [0.04, ...Array.from({ length: 19 }, (_, i) => 0.2 + i * 0.04)];
  assert.equal(pvals.filter((p) => p < 0.05).length, 1, 'one would pass uncorrected');
  assert.equal(benjaminiHochberg(pvals, 0.1).filter(Boolean).length, 0, 'none survives correction');
});

// ------------------------------------------------------------- ledger
test('ledger: an alert document maps onto the learner trade shape', () => {
  const doc = {
    _id: 'abc',
    instrumentId: 'VOL75',
    instrumentKind: 'synthetic',
    candleTime: new Date(1700000000 * 1000),
    direction: 'bullish',
    htfBias: { strength: 'strong', score: 2 },
    score: 5,
    confirmations: [
      { id: 'ltf_structure', passed: true },
      { id: 'premium_discount', passed: false },
    ],
    features: ['pattern:double_bottom', 'session:london'],
    poiKind: 'OB',
    shadow: true,
    tradePlan: { entryPrice: 100, stopPrice: 90, riskDistance: 10, riskReward: 2, targets: [{ cappedBy: { price: 120 } }] },
    outcome: { status: 'tp2', rMultiple: 2.05, barsHeld: 12, mfe: 3, mae: -0.4 },
  };

  const t = ledger.fromAlertDocument(doc);
  assert.equal(t.source, 'live-shadow');
  assert.equal(t.instrumentId, 'VOL75');
  assert.equal(t.time, 1700000000);
  assert.deepEqual(t.confirmations, ['ltf_structure'], 'only the checks that fired');
  assert.deepEqual(t.features, ['pattern:double_bottom', 'session:london']);
  assert.equal(t.biasStrength, 'strong');
  assert.equal(t.status, 'tp2');
  assert.equal(t.rMultiple, 2.05);
  assert.equal(t.filled, true);
  assert.equal(t.targetCapped, true);
  assert.equal(t.poiKind, 'OB');

  const delivered = ledger.fromAlertDocument({ ...doc, shadow: false });
  assert.equal(delivered.source, 'live');

  const expired = ledger.fromAlertDocument({ ...doc, outcome: { status: 'expired' } });
  assert.equal(expired.filled, false);
  assert.equal(expired.rMultiple, 0);
});

test('ledger: a live record supersedes the backtest record for the same bar', () => {
  const backtest = [
    { source: 'backtest', instrumentId: 'X', time: 100, rMultiple: -1, filled: true },
    { source: 'backtest', instrumentId: 'X', time: 200, rMultiple: 2, filled: true },
  ];
  const live = [{ source: 'live', instrumentId: 'X', time: 200, rMultiple: 3, filled: true }];

  const merged = ledger.mergeLedger(backtest, live);
  assert.equal(merged.length, 2, 'the overlapping bar is not counted twice');
  assert.equal(merged.find((t) => t.time === 200).source, 'live', 'the real outcome wins');
  assert.deepEqual(merged.map((t) => t.time), [100, 200], 'chronological');
});

test('ledger: seed trades round-trip through disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  const file = path.join(dir, 'seed.json');
  const trades = makeTrades({ n: 5 });

  assert.equal(ledger.saveBacktestTrades(file, trades, { bars: 100 }), 5);
  const loaded = ledger.loadBacktestTrades(file);
  assert.equal(loaded.length, 5);
  assert.equal(loaded[0].source, 'backtest');
  assert.deepEqual(loaded[0].features, trades[0].features);

  assert.deepEqual(ledger.loadBacktestTrades(path.join(dir, 'absent.json')), [], 'a missing seed is not an error');
  assert.deepEqual(ledger.ledgerSummary(loaded), { total: 5, bySource: { backtest: 5 } });
});

// ------------------------------------------------------------- outcomes
const PENDING_DOC = {
  _id: 'doc1',
  instrumentId: 'X',
  direction: 'bullish',
  candleTime: new Date(1700000000 * 1000),
  price: 100,
  tradePlan: {
    entryPrice: 100,
    stopPrice: 90,
    riskDistance: 10,
    targets: [
      { name: 'TP1', price: 120, closePct: 50, moveStopToBreakeven: true },
      { name: 'TP2', price: 135, closePct: 30, trailToStructure: true },
      { name: 'TP3', price: 150, closePct: 20 },
    ],
  },
};

const bar = (time, high, low, close) => ({ time, open: close, high, low, close });

function fakeDb(pending) {
  const recorded = [];
  return {
    recorded,
    pendingAlerts: async () => pending,
    recordOutcome: async (id, outcome) => {
      recorded.push({ id, outcome });
      return {};
    },
  };
}

test('outcomes: a resolved setup is written back with its R multiple', async () => {
  const db = fakeDb([PENDING_DOC]);
  const candles = [bar(1700001800, 121, 99, 120), bar(1700003600, 136, 119, 135), bar(1700005400, 151, 134, 150)];

  const result = await resolvePending({
    db,
    instrument: { id: 'X' },
    candles,
    opts: { maxBars: 3 },
    now: 1700000000 + 3 * 1800,
  });

  assert.equal(result.resolved, 1);
  assert.equal(db.recorded.length, 1);
  assert.equal(db.recorded[0].outcome.status, 'tp3');
  assert.ok(Math.abs(db.recorded[0].outcome.rMultiple - 3.05) < 1e-9);
  assert.equal(db.recorded[0].outcome.resolvedBy, 'simulator');
});

test('outcomes: a still-running trade stays pending instead of being marked a loss', async () => {
  const db = fakeDb([PENDING_DOC]);
  const candles = [bar(1700001800, 105, 98, 101), bar(1700003600, 106, 99, 102)];

  const result = await resolvePending({
    db,
    instrument: { id: 'X' },
    candles,
    opts: { maxBars: 96 },
    now: 1700000000 + 2 * 1800, // the window is nowhere near closed
  });

  assert.equal(result.resolved, 0);
  assert.equal(result.stillOpen, 1);
  assert.equal(db.recorded.length, 0);
});

test('outcomes: once the window closes, an unresolved trade is marked out', async () => {
  const db = fakeDb([PENDING_DOC]);
  const candles = Array.from({ length: 5 }, (_, i) => bar(1700001800 + i * 1800, 105, 98, 101));

  const result = await resolvePending({
    db,
    instrument: { id: 'X' },
    candles,
    opts: { maxBars: 4 },
    now: 1700000000 + 500 * 1800,
  });

  assert.equal(result.resolved, 1);
  assert.equal(db.recorded[0].outcome.status, 'timeout');
});

test('outcomes: a document without a usable plan is skipped, not crashed on', async () => {
  const db = fakeDb([{ ...PENDING_DOC, tradePlan: { entryPrice: 100 } }]);
  const result = await resolvePending({
    db,
    instrument: { id: 'X' },
    candles: [bar(1700001800, 121, 99, 120)],
    opts: { maxBars: 1 },
    now: 1700000000 + 500 * 1800,
  });
  assert.equal(result.resolved, 0);
  assert.equal(db.recorded.length, 0);
  assert.equal(toPlan({ tradePlan: { entryPrice: 1 } }), null);
});

test('outcomes: nothing pending is a cheap no-op', async () => {
  const db = fakeDb([]);
  assert.deepEqual(await resolvePending({ db, instrument: { id: 'X' }, candles: [] }), {
    checked: 0,
    resolved: 0,
    stillOpen: 0,
  });
});

// ------------------------------------------------------------- growth loop
test('service: relearns only once enough new outcomes have landed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-'));
  const profilePath = path.join(dir, 'edge-profile.json');
  const seedPath = path.join(dir, 'seed.json');
  ledger.saveBacktestTrades(seedPath, makeTrades({ n: 600, signal: 'pattern:double_bottom' }));

  const service = new LearningService({
    db: { resolvedAlerts: async () => [] },
    profilePath,
    seedPath,
    cfg: { relearnEvery: 3, minSamples: 30, tradesPerRule: 100, maxFeatureRules: 4, maxLedgerTrades: 100 },
  });

  assert.equal(await service.relearn(), null, 'nothing new yet');

  service.resolvedSinceLearn = 3;
  const run = await service.relearn();
  assert.ok(run);
  assert.equal(service.resolvedSinceLearn, 0, 'the counter resets after learning');

  const profile = EdgeProfile.load(profilePath);
  assert.equal(profile.loaded, true);
  assert.deepEqual(profile.rules.requiredFeatures, ['pattern:double_bottom']);
  assert.equal(profile.validated, true);
  assert.equal(profile.data.meta.ledger.total, 600);
});

test('service: reports when the rules actually change', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learn2-'));
  const profilePath = path.join(dir, 'edge-profile.json');
  const seedPath = path.join(dir, 'seed.json');
  ledger.saveBacktestTrades(seedPath, makeTrades({ n: 600, signal: 'pattern:double_bottom' }));

  const changes = [];
  const service = new LearningService({
    db: { resolvedAlerts: async () => [] },
    profilePath,
    seedPath,
    cfg: { relearnEvery: 1, minSamples: 30, tradesPerRule: 100, maxFeatureRules: 4, maxLedgerTrades: 100 },
    onProfileChange: (r) => changes.push(r),
  });

  service.resolvedSinceLearn = 1;
  await service.relearn();
  assert.equal(changes.length, 1, 'first run is a change from nothing');

  service.resolvedSinceLearn = 1;
  const second = await service.relearn();
  assert.equal(second.changed, false, 'the same data yields the same rules');
  assert.equal(changes.length, 1);
});

test('service: an empty ledger leaves the existing profile alone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learn3-'));
  const service = new LearningService({
    db: { resolvedAlerts: async () => [] },
    profilePath: path.join(dir, 'edge-profile.json'),
    seedPath: path.join(dir, 'missing.json'),
    cfg: { relearnEvery: 1 },
  });
  service.resolvedSinceLearn = 5;
  assert.equal(await service.relearn(), null);
  assert.equal(fs.existsSync(path.join(dir, 'edge-profile.json')), false);
});

test('service: live outcomes join the backtest seed in one ledger', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learn4-'));
  const seedPath = path.join(dir, 'seed.json');
  ledger.saveBacktestTrades(seedPath, makeTrades({ n: 200, signal: 'pattern:double_bottom', seed: 3 }));

  const liveDocs = makeTrades({ n: 40, signal: 'pattern:double_bottom', seed: 4 }).map((t, i) => ({
    _id: `live${i}`,
    instrumentId: 'X',
    candleTime: new Date((1800000000 + i * 1800) * 1000),
    direction: 'bullish',
    htfBias: { strength: 'moderate' },
    score: 4,
    confirmations: [{ id: 'ltf_structure', passed: true }],
    features: t.features,
    tradePlan: { entryPrice: 1, stopPrice: 0.9, riskDistance: 0.1, riskReward: 2, targets: [] },
    outcome: { status: t.status, rMultiple: t.rMultiple },
  }));

  const service = new LearningService({
    db: { resolvedAlerts: async () => liveDocs },
    profilePath: path.join(dir, 'edge-profile.json'),
    seedPath,
    cfg: { relearnEvery: 1, minSamples: 30, tradesPerRule: 100, maxFeatureRules: 4, maxLedgerTrades: 1000 },
  });

  service.resolvedSinceLearn = 1;
  const run = await service.relearn();
  assert.equal(run.summary.total, 240, 'seed plus live');
  assert.equal(run.summary.bySource.backtest, 200);
  assert.equal(run.summary.bySource.live, 40);
});

test('learner: a score rule does not starve the feature search', () => {
  // Most trades score 3; only a fifth score 5. If features were screened
  // AFTER the score rule narrows the pool, almost nothing would be testable —
  // which is exactly the bug this guards against.
  const rand = mulberry32(17);
  const trades = Array.from({ length: 500 }, (_, i) => {
    const highScore = rand() < 0.2;
    const carries = rand() < 0.5;
    const features = ['dir:bullish', 'instrument:X'];
    if (carries) features.push('pa:break_retest');
    for (const t of NOISE_TOKENS.slice(0, 6)) if (rand() < 0.3) features.push(t);
    const win = rand() < (highScore ? 0.7 : 0.3);
    return {
      source: 'backtest',
      instrumentId: 'X',
      time: 1700000000 + i * 1800,
      score: highScore ? 5 : 3,
      confirmations: ['ltf_structure'],
      features: [...new Set(features)].sort(),
      direction: 'bullish',
      biasStrength: 'moderate',
      filled: true,
      status: win ? 'tp1' : 'stopped',
      rMultiple: win ? 2 : -1,
    };
  });

  const result = learn(trades, { minSamples: 30 });
  assert.ok(result.rules.minScore >= 4, 'the score rule was selected and narrowed the pool');

  const tested = result.candidates.map((c) => c.feature);
  assert.ok(
    tested.includes('pa:break_retest'),
    'a feature spread across the whole sample must still be screened, not lost to the score rule'
  );
  assert.ok(result.candidates.length >= 5, `only ${result.candidates.length} features were testable`);
});

test('learner: it says so when a score rule leaves too little to build on', () => {
  const rand = mulberry32(23);
  const trades = Array.from({ length: 300 }, (_, i) => {
    const highScore = rand() < 0.12; // a very thin high-score cohort
    const win = rand() < (highScore ? 0.8 : 0.28);
    return {
      source: 'backtest',
      instrumentId: 'X',
      time: 1700000000 + i * 1800,
      score: highScore ? 6 : 3,
      confirmations: ['ltf_structure'],
      features: ['dir:bullish', 'pa:break_retest'],
      direction: 'bullish',
      biasStrength: 'moderate',
      filled: true,
      status: win ? 'tp1' : 'stopped',
      rMultiple: win ? 2 : -1,
    };
  });

  const result = learn(trades, { minSamples: 30, tradesPerRule: 100 });
  if (result.rules.minScore) {
    assert.match(
      result.notes.join(' '),
      /too few to add a feature rule|No feature|survive the score rule/,
      'a starved pool is reported rather than quietly producing rules from nothing'
    );
  }
  assert.ok(result.rules.requiredFeatures.length <= 1);
});

test('outcomes: a weekend gap does not resolve a trade on too few candles', async () => {
  // Friday setup; the market then closes. By Monday 48+ clock hours have passed
  // — more than the 96-bar window — but only four real candles exist.
  const db = fakeDb([PENDING_DOC]);
  const fridayCandles = Array.from({ length: 4 }, (_, i) => bar(1700001800 + i * 1800, 105, 98, 101));
  const mondayMorning = 1700000000 + 60 * 3600;

  const result = await resolvePending({
    db,
    instrument: { id: 'EURUSD' },
    candles: fridayCandles,
    opts: { maxBars: 96, barSeconds: 1800 },
    now: mondayMorning,
  });

  assert.equal(result.resolved, 0, 'the window is counted in candles, not clock time');
  assert.equal(result.stillOpen, 1);
  assert.equal(db.recorded.length, 0);
});

test('outcomes: a trade that resolves before the weekend is still recorded', async () => {
  const db = fakeDb([PENDING_DOC]);
  // Stops out on the first candle, well before the window fills.
  const candles = [bar(1700001800, 101, 89, 90)];
  const result = await resolvePending({
    db,
    instrument: { id: 'EURUSD' },
    candles,
    opts: { maxBars: 96, barSeconds: 1800 },
    now: 1700000000 + 60 * 3600,
  });
  assert.equal(result.resolved, 1);
  assert.equal(db.recorded[0].outcome.status, 'stopped');
});

test('outcomes: a feed that has stopped entirely is eventually closed out', async () => {
  const db = fakeDb([PENDING_DOC]);
  const candles = Array.from({ length: 4 }, (_, i) => bar(1700001800 + i * 1800, 105, 98, 101));
  // Far beyond a long weekend: 4x the window with still only four candles.
  const result = await resolvePending({
    db,
    instrument: { id: 'EURUSD' },
    candles,
    opts: { maxBars: 96, barSeconds: 1800, staleFactor: 4 },
    now: 1700000000 + 96 * 1800 * 5,
  });
  assert.equal(result.resolved, 1);
  assert.equal(db.recorded[0].outcome.status, 'timeout');
});
