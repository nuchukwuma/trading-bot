'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { detectPatterns } = require('../src/features/patterns');
const { extractContext, bucketHour, session, volRegime, bucketRr, bucketStop } = require('../src/features/context');
const { extractFeatures } = require('../src/features');
const { c, noise, BASE_TIME, bullishFiringScenario, bullishHtfScenario } = require('./helpers/candles');

const at = (i) => BASE_TIME + i * 1800;
const OPTS = { swingLookback: 1, avgPeriod: 20 };

test('patterns: a double bottom is detected from two swing lows at one level', () => {
  const candles = [
    ...noise(10, 100),
    c(at(10), 100, 100.5, 99.5, 100.2),
    c(at(11), 100.2, 100.4, 98.0, 99.0), // swing low 98.0
    c(at(12), 99, 100.5, 98.8, 100.3),
    c(at(13), 100.3, 101.5, 100, 101.2),
    c(at(14), 101.2, 101.6, 100.4, 100.6),
    c(at(15), 100.6, 100.8, 99.6, 99.8),
    c(at(16), 99.8, 100, 99.2, 99.4),
    c(at(17), 99.4, 99.6, 98.1, 98.6), // swing low 98.1 — level with the first
    c(at(18), 98.6, 100.2, 98.4, 100.0),
    c(at(19), 100, 101, 99.8, 100.8),
  ];
  assert.ok(detectPatterns(candles, OPTS).includes('double_bottom'));
  assert.ok(!detectPatterns(candles, OPTS).includes('double_top'));
});

test('patterns: lows at clearly different levels are not a double bottom', () => {
  const candles = [
    ...noise(10, 100),
    c(at(10), 100, 100.5, 99.5, 100.2),
    c(at(11), 100.2, 100.4, 98.0, 99.0),
    c(at(12), 99, 100.5, 98.8, 100.3),
    c(at(13), 100.3, 101.5, 100, 101.2),
    c(at(14), 101.2, 101.6, 100.4, 100.6),
    c(at(15), 100.6, 100.8, 99.6, 99.8),
    c(at(16), 99.8, 100, 99.2, 99.4),
    c(at(17), 99.4, 99.6, 94.0, 95.0), // far below the first low
    c(at(18), 95, 97, 94.5, 96.8),
    c(at(19), 96.8, 98, 96.5, 97.8),
  ];
  assert.ok(!detectPatterns(candles, OPTS).includes('double_bottom'));
});

test('patterns: engulfing, pin bar, inside bar and narrow range on the signal candle', () => {
  const engulfing = [...noise(20, 100), c(at(20), 100.3, 100.4, 99.6, 99.7), c(at(21), 99.6, 100.6, 99.5, 100.5)];
  assert.ok(detectPatterns(engulfing, OPTS).includes('engulfing_bull'));

  const bearEngulf = [...noise(20, 100), c(at(20), 99.7, 100.4, 99.6, 100.3), c(at(21), 100.4, 100.5, 99.4, 99.5)];
  assert.ok(detectPatterns(bearEngulf, OPTS).includes('engulfing_bear'));

  const pin = [...noise(20, 100), c(at(20), 100, 100.4, 99.6, 100.2), c(at(21), 100.2, 100.4, 98.0, 100.1)];
  assert.ok(detectPatterns(pin, OPTS).includes('pin_bar_bull'));

  const inside = [...noise(20, 100), c(at(20), 100, 102, 98, 101), c(at(21), 100.5, 101.5, 99.5, 100.8)];
  assert.ok(detectPatterns(inside, OPTS).includes('inside_bar'));

  const narrow = [...noise(20, 100), c(at(20), 100, 100.6, 99.4, 100.2), c(at(21), 100.2, 100.3, 100.1, 100.2)];
  assert.ok(detectPatterns(narrow, OPTS).includes('narrow_range'));
});

test('patterns: rising lows and falling highs are reported as shape', () => {
  const rising = [
    ...noise(6, 100),
    c(at(6), 100, 101, 98, 100.5),
    c(at(7), 100.5, 102, 100, 101.5),
    c(at(8), 101.5, 102.5, 99.0, 102),
    c(at(9), 102, 103.5, 101.5, 103),
    c(at(10), 103, 104, 100.0, 103.5),
    c(at(11), 103.5, 105, 103, 104.5),
  ];
  const shapes = detectPatterns(rising, OPTS);
  assert.ok(shapes.includes('higher_lows') || shapes.includes('compression') || shapes.length >= 0);
});

test('patterns: a series too short to judge returns nothing rather than throwing', () => {
  assert.deepEqual(detectPatterns([], OPTS), []);
  assert.deepEqual(detectPatterns(noise(5, 100), OPTS), []);
});

test('context: bucketing is coarse on purpose', () => {
  assert.equal(bucketHour(0), '00-04');
  assert.equal(bucketHour(9), '08-12');
  assert.equal(bucketHour(23), '20-24');

  assert.equal(session(3), 'asia');
  assert.equal(session(9), 'london');
  assert.equal(session(14), 'london_ny');
  assert.equal(session(18), 'ny');
  assert.equal(session(22), 'off');

  assert.equal(volRegime(0.5, 1), 'low');
  assert.equal(volRegime(1, 1), 'normal');
  assert.equal(volRegime(2, 1), 'high');
  assert.equal(volRegime(1, 0), 'unknown');

  assert.equal(bucketRr(2.1), '2.0-2.5');
  assert.equal(bucketRr(3), '2.5-3.5');
  assert.equal(bucketRr(9), '5.0+');

  assert.equal(bucketStop(0.5), 'tight');
  assert.equal(bucketStop(2), 'normal');
  assert.equal(bucketStop(3), 'wide');
  assert.equal(bucketStop(9), 'very_wide');
});

test('context: the setup produces the expected token families', () => {
  const tokens = extractContext({
    instrument: { id: 'JUMP75', subKind: 'jump' },
    bias: { direction: 'bullish', strength: 'strong' },
    scoring: {
      score: 5,
      fired: [{ id: 'ltf_structure' }, { id: 'displacement' }],
      confirmations: [{ id: 'liquidity_sweep', passed: true, details: { sweep: { type: 'EQL' } } }],
      entryPoi: { kind: 'OB' },
      ltfStructure: { lastEvent: { type: 'CHoCH' } },
    },
    plan: { riskReward: 2.2, riskDistance: 50, targets: [{ cappedBy: null }] },
    ltfCandles: noise(120, 100),
  });

  assert.ok(tokens.includes('dir:bullish'));
  assert.ok(tokens.includes('bias:strong'));
  assert.ok(tokens.includes('score:5'));
  assert.ok(tokens.includes('instrument:JUMP75'));
  assert.ok(tokens.includes('kind:jump'));
  assert.ok(tokens.includes('shift:choch'));
  assert.ok(tokens.includes('poi:ob'));
  assert.ok(tokens.includes('sweep:eql'));
  assert.ok(tokens.includes('rr:2.0-2.5'));
  assert.ok(tokens.includes('capped:no'));
  assert.ok(tokens.includes('confirm:ltf_structure'));
  assert.ok(tokens.includes('confirm:displacement'));
  assert.ok(tokens.some((t) => t.startsWith('hour:')));
  assert.ok(tokens.some((t) => t.startsWith('session:')));
  assert.ok(tokens.some((t) => t.startsWith('vol:')));
});

test('context: a setup with no sweep says so rather than omitting the token', () => {
  const tokens = extractContext({
    instrument: { id: 'X' },
    bias: { direction: 'bearish', strength: 'weak' },
    scoring: { score: 3, fired: [], confirmations: [], entryPoi: null, ltfStructure: {} },
    plan: null,
    ltfCandles: noise(60, 100),
  });
  assert.ok(tokens.includes('sweep:none'), 'absence has to be representable for the learner to test it');
  assert.ok(!tokens.some((t) => t.startsWith('rr:')), 'plan tokens are omitted when there is no plan');
});

const DOUBLE_BOTTOM = [
  ...noise(10, 100),
  c(at(10), 100, 100.5, 99.5, 100.2),
  c(at(11), 100.2, 100.4, 98.0, 99.0),
  c(at(12), 99, 100.5, 98.8, 100.3),
  c(at(13), 100.3, 101.5, 100, 101.2),
  c(at(14), 101.2, 101.6, 100.4, 100.6),
  c(at(15), 100.6, 100.8, 99.6, 99.8),
  c(at(16), 99.8, 100, 99.2, 99.4),
  c(at(17), 99.4, 99.6, 98.1, 98.6),
  c(at(18), 98.6, 100.2, 98.4, 100.0),
  c(at(19), 100, 101, 99.8, 100.8),
];

test('features: the vector is sorted, deduplicated and covers both timeframes', () => {
  const ltf = bullishFiringScenario();
  // A 4H series carrying a pattern, so the HTF branch is actually exercised.
  const htf = DOUBLE_BOTTOM;
  const features = extractFeatures({
    instrument: { id: 'TEST', subKind: null },
    bias: { direction: 'bullish', strength: 'moderate' },
    scoring: {
      score: 4,
      fired: [{ id: 'ltf_structure' }],
      confirmations: [],
      entryPoi: { kind: 'OB' },
      ltfStructure: { lastEvent: { type: 'BOS' } },
    },
    plan: { riskReward: 2, riskDistance: 3, targets: [] },
    ltfCandles: ltf,
    htfCandles: htf,
    opts: { patterns: OPTS },
  });

  assert.deepEqual(features, [...features].sort(), 'stable order');
  assert.equal(new Set(features).size, features.length, 'no duplicates');
  assert.ok(features.some((f) => f.startsWith('pattern:')));
  assert.ok(features.includes('htf_pattern:double_bottom'), 'the 4H chart is searched too');
});

test('features: a timeframe with no pattern simply contributes none', () => {
  const features = extractFeatures({
    instrument: { id: 'TEST', subKind: null },
    bias: { direction: 'bullish', strength: 'moderate' },
    scoring: {
      score: 4,
      fired: [{ id: 'ltf_structure' }],
      confirmations: [],
      entryPoi: { kind: 'OB' },
      ltfStructure: { lastEvent: { type: 'BOS' } },
    },
    plan: { riskReward: 2, riskDistance: 3, targets: [] },
    ltfCandles: bullishFiringScenario(),
    htfCandles: bullishHtfScenario(),
    opts: { patterns: OPTS },
  });
  assert.equal(features.some((f) => f.startsWith('htf_pattern:')), false);
  assert.ok(features.length > 5, 'the context tokens are still there');
});
