'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { simulateTrade } = require('../src/backtest/simulator');
const { resolvePending, recordVariants } = require('../src/learn/outcomeTracker');
const { computeVariants, BASELINE, keyOf, STOP_SCALES, tp1Choices } = require('../src/learn/planVariants');
const { learnPlan, adjustmentFor } = require('../src/learn/planLearner');
const { EdgeProfile } = require('../src/backtest/edgeProfile');
const { formatTradeEvent } = require('../src/alerts/tradeUpdates');

const T0 = 1700000000;
const bar = (i, high, low, close) => ({ time: T0 + i * 1800, open: close, high, low, close });

const PLAN = {
  direction: 'bullish',
  entryPrice: 100,
  stopPrice: 90,
  riskDistance: 10,
  targets: [
    { name: 'TP1', price: 120, closePct: 50, moveStopToBreakeven: true },
    { name: 'TP2', price: 135, closePct: 30, trailToStructure: true },
    { name: 'TP3', price: 150, closePct: 20 },
  ],
};

// ------------------------------------------------------------ invalidation
test('simulator: price reaching TP1 before the entry cancels the limit', () => {
  const o = simulateTrade({ plan: PLAN, candles: [bar(1, 115, 103, 110), bar(2, 121, 108, 120)], signalClose: 104 });
  assert.equal(o.filled, false);
  assert.equal(o.status, 'expired');
  assert.equal(o.invalidReason, 'ran_to_target');
});

test('simulator: an unfilled limit reports no reason while its window is still open', () => {
  const open = simulateTrade({ plan: PLAN, candles: [bar(1, 106, 102, 105)], signalClose: 104 });
  assert.equal(open.invalidReason, null);
  const full = simulateTrade({
    plan: PLAN,
    candles: Array.from({ length: 8 }, (_, i) => bar(i + 1, 106, 102, 105)),
    signalClose: 104,
  });
  assert.equal(full.invalidReason, 'no_fill');
});

const DOC = {
  _id: 'd1',
  instrumentId: 'EURUSD',
  side: 'BUY',
  direction: 'bullish',
  delivered: true,
  candleTime: new Date(T0 * 1000),
  price: 104,
  tradePlan: { ...PLAN, riskUsd: 3 },
};

function db(doc) {
  const s = { doc: { ...doc }, recorded: null, variants: undefined };
  return {
    s,
    pendingAlerts: async () => (s.recorded ? [] : [s.doc]),
    updateProgress: async (id, p) => {
      s.doc = { ...s.doc, progress: p };
    },
    recordOutcome: async (id, o) => {
      s.recorded = o;
    },
    alertsNeedingVariants: async () => (s.recorded && s.variants === undefined ? [{ ...s.doc, outcome: s.recorded }] : []),
    setVariants: async (id, v) => {
      s.variants = v;
    },
  };
}

test('tracking: a setup that ran to TP1 without filling is reported invalidated at once', async () => {
  const d = db(DOC);
  const events = [];
  await resolvePending({
    db: d,
    instrument: { id: 'EURUSD' },
    candles: [bar(1, 121, 103, 119)],
    now: T0 + 1800,
    onEvent: async (doc, e) => events.push(e),
  });
  assert.equal(d.s.recorded.status, 'expired');
  assert.equal(d.s.recorded.invalidReason, 'ran_to_target');
  assert.match(formatTradeEvent(DOC, events[0]), /Invalidated[\s\S]*reached TP1[\s\S]*without coming back/);
});

test('tracking: a 4H bias flip before the fill cancels the setup and says why', async () => {
  const d = db(DOC);
  const events = [];
  await resolvePending({
    db: d,
    instrument: { id: 'EURUSD' },
    candles: [bar(1, 106, 102, 105)],
    now: T0 + 1800,
    currentBias: { direction: 'bearish' },
    onEvent: async (doc, e) => events.push(e),
  });
  assert.equal(d.s.recorded.status, 'cancelled');
  assert.equal(d.s.recorded.invalidReason, 'bias_flip');
  assert.match(formatTradeEvent(DOC, events[0]), /Invalidated[\s\S]*4H bias turned bearish/);
});

test('tracking: a bias flip after the fill does not cancel a live trade', async () => {
  const d = db(DOC);
  await resolvePending({
    db: d,
    instrument: { id: 'EURUSD' },
    candles: [bar(1, 105, 99, 101)],
    now: T0 + 1800,
    currentBias: { direction: 'bearish' },
  });
  assert.equal(d.s.recorded, null);
  assert.equal(d.s.doc.progress.filled, true);
});

// ------------------------------------------------------------ variants
test('variants: 12 placements, and the baseline matches the default plan', () => {
  const candles = [bar(1, 105, 99, 101), bar(2, 121, 101, 118), bar(3, 136, 117, 135), bar(4, 151, 134, 150)];
  const v = computeVariants({ direction: 'bullish', entryPrice: 100, baseRisk: 10, candles, signalClose: 104 });
  assert.equal(Object.keys(v).length, STOP_SCALES.length * tp1Choices().length);
  const direct = simulateTrade({ plan: PLAN, candles, signalClose: 104 });
  assert.equal(v[BASELINE()], direct.rMultiple);
});

test('variants: a placement the 1:2 gate would reject scores as no trade', () => {
  // Liquidity 15 above entry caps every target; only the tight stop still clears 2R.
  const v = computeVariants({
    direction: 'bullish',
    entryPrice: 100,
    baseRisk: 10,
    obstacle: { price: 115 },
    candles: [bar(1, 116, 99, 115)],
    signalClose: 100,
  });
  assert.equal(v[keyOf(1, 2)], 0);
  assert.equal(v[keyOf(1.5, 2)], 0);
});

test('tracking: variants are stored once a resolved setup has a full window of candles', async () => {
  const d = db(DOC);
  d.s.recorded = { status: 'stopped' };
  const candles = Array.from({ length: 96 }, (_, i) => bar(i + 1, 105, 95, 100));
  const n = await recordVariants({ db: d, instrument: { id: 'EURUSD' }, candles: [bar(0, 104, 104, 104), ...candles], now: T0 + 97 * 1800 });
  assert.equal(n, 1);
  assert.ok(Number.isFinite(d.s.variants[BASELINE()]));
});

// ------------------------------------------------------------ learner
const base = BASELINE();
const better = keyOf(1.25, 2.5);

function ledger(n, { gain, noise = 0.2, instrumentId = 'EURUSD', trainOnly = false }) {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: n }, (_, i) => {
    const r = rand() < 0.4 ? 2 : -1;
    const lift = trainOnly && i >= n * 0.7 ? -gain : gain;
    const variants = {};
    for (const s of STOP_SCALES) for (const t of tp1Choices()) variants[keyOf(s, t)] = r + (rand() - 0.5) * noise;
    variants[base] = r;
    variants[better] = r + lift + (rand() - 0.5) * noise;
    return { instrumentId, time: i, variants };
  });
}

test('plan learner: adopts a placement that beats the default on earlier AND later trades', () => {
  const plan = learnPlan(ledger(200, { gain: 0.4 }), { minSamples: 30, minTestSamples: 20 });
  assert.equal(plan.byGroup.forex.key, better);
  assert.equal(plan.byGroup.forex.stopScale, 1.25);
  assert.equal(plan.byGroup.forex.tp1R, 2.5);
  assert.ok(plan.byGroup.forex.adjustedR > plan.byGroup.forex.baselineR);
});

test('plan learner: an improvement that vanishes on later trades is not adopted', () => {
  const plan = learnPlan(ledger(200, { gain: 0.4, trainOnly: true }), { minSamples: 30, minTestSamples: 20 });
  assert.equal(plan.byGroup.forex, undefined);
  assert.ok(plan.notes.some((n) => /not adopted/.test(n)));
});

test('plan learner: pure noise changes nothing', () => {
  const plan = learnPlan(ledger(200, { gain: 0, noise: 0.5 }), { minSamples: 30, minTestSamples: 20 });
  assert.deepEqual(Object.keys(plan.byGroup), []);
});

test('plan learner: too few trades waits instead of guessing', () => {
  const plan = learnPlan(ledger(20, { gain: 1 }), { minSamples: 30, minTestSamples: 20 });
  assert.deepEqual(plan.byGroup, {});
  assert.ok(plan.notes.some((n) => /needed before testing/.test(n)));
});

test('edge profile: an instrument gets its own group placement, else the all-pairs one', () => {
  const plan = { byGroup: { forex: { key: 'fx' }, all: { key: 'all' } } };
  assert.equal(adjustmentFor(plan, 'EURUSD').key, 'fx');
  assert.equal(adjustmentFor(plan, 'VOL75').key, 'all');
  const profile = new EdgeProfile({ version: 1, validated: false, rules: {}, plan });
  assert.equal(profile.planFor('GBPJPY').key, 'fx');
  assert.equal(new EdgeProfile(null).planFor('EURUSD'), null);
});
