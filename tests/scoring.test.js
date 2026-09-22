'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { scoreSetup, achievableEntry } = require('../src/scoring');
const {
  checkStructureAlignment,
  checkLiquiditySweep,
  checkPoiRetrace,
  checkPremiumDiscount,
  checkHtfConfluence,
  checkDisplacement,
} = require('../src/scoring/checks');
const { detectSwings } = require('../src/structure/swings');
const { analyzeStructure } = require('../src/structure/marketStructure');
const { dealingRange } = require('../src/structure/range');
const { bullishScenario, noise, c, BASE_TIME } = require('./helpers/candles');

const at = (i) => BASE_TIME + i * 1800;
const INSTRUMENT = { id: 'TEST', kind: 'synthetic', pricePrecision: 2, pipSize: 1 };
const STRUCT_OPTS = { swingLookback: 1, breakOnClose: true };

const livePoi = (o) => ({ kind: 'OB', mitigated: false, violated: false, index: 5, time: 0, ...o });

// ---------------------------------------------------------------- check 1
test('check 1: a 30m shift agreeing with the HTF bias fires', () => {
  const ctx = {
    instrument: INSTRUMENT,
    bias: { direction: 'bullish' },
    ltfCandles: new Array(20),
    ltfStructure: { lastEvent: { index: 18, type: 'BOS', direction: 'bullish', brokenSwing: { price: 103 } } },
    opts: {},
  };
  const r = checkStructureAlignment(ctx);
  assert.equal(r.passed, true);
  assert.match(r.reason, /30m BOS aligned with HTF bias/);
  assert.match(r.reason, /103\.00/);
});

test('check 1: a counter-trend shift or a stale one does not fire', () => {
  const base = {
    instrument: INSTRUMENT,
    bias: { direction: 'bullish' },
    ltfCandles: new Array(40),
    opts: {},
  };
  const against = checkStructureAlignment({
    ...base,
    ltfStructure: { lastEvent: { index: 38, type: 'CHoCH', direction: 'bearish', brokenSwing: { price: 99 } } },
  });
  assert.equal(against.passed, false);
  assert.match(against.reason, /against the bullish 4H bias/);

  const stale = checkStructureAlignment({
    ...base,
    ltfStructure: { lastEvent: { index: 5, type: 'BOS', direction: 'bullish', brokenSwing: { price: 99 } } },
    opts: { scoring: { maxEventAgeCandles: 10 } },
  });
  assert.equal(stale.passed, false);
  assert.match(stale.reason, /stale \(34 candles ago\)/);

  const none = checkStructureAlignment({ ...base, ltfStructure: { lastEvent: null } });
  assert.equal(none.passed, false);
  assert.match(none.reason, /No 30m structural break/);
});

// ---------------------------------------------------------------- check 2
test('check 2: the sweep ahead of the shift fires with its reason', () => {
  const candles = bullishScenario();
  const ltfStructure = analyzeStructure(candles, STRUCT_OPTS);
  const r = checkLiquiditySweep({
    instrument: INSTRUMENT,
    bias: { direction: 'bullish' },
    ltfCandles: candles,
    ltfStructure,
    opts: {},
  });
  assert.equal(r.passed, true);
  assert.match(r.reason, /Liquidity sweep before shift — stop hunt below the prior swing at 98\.00/);
  assert.equal(r.details.sweep.index, 17);
});

test('check 2: no sweep means no confirmation', () => {
  const candles = noise(30, 100);
  const r = checkLiquiditySweep({
    instrument: INSTRUMENT,
    bias: { direction: 'bullish' },
    ltfCandles: candles,
    ltfStructure: analyzeStructure(candles, STRUCT_OPTS),
    opts: {},
  });
  assert.equal(r.passed, false);
  assert.match(r.reason, /No liquidity sweep/);
});

// ---------------------------------------------------------------- check 3
test('check 3: price inside an unmitigated aligned POI fires', () => {
  const r = checkPoiRetrace({
    instrument: INSTRUMENT,
    bias: { direction: 'bullish' },
    price: 100.5,
    ltfPois: [livePoi({ direction: 'bullish', top: 101, bottom: 100 })],
    opts: {},
  });
  assert.equal(r.passed, true);
  assert.match(r.reason, /Retrace into an unmitigated 30m order block at 100\.00-101\.00/);
});

test('check 3: not yet retraced, mitigated, or nothing to retrace into', () => {
  const notYet = checkPoiRetrace({
    instrument: INSTRUMENT,
    bias: { direction: 'bullish' },
    price: 105,
    ltfPois: [livePoi({ direction: 'bullish', top: 101, bottom: 100 })],
    opts: {},
  });
  assert.equal(notYet.passed, false);
  assert.match(notYet.reason, /has not yet retraced/);

  const mitigated = checkPoiRetrace({
    instrument: INSTRUMENT,
    bias: { direction: 'bullish' },
    price: 100.5,
    ltfPois: [livePoi({ direction: 'bullish', top: 101, bottom: 100, mitigated: true })],
    opts: {},
  });
  assert.equal(mitigated.passed, false);
  assert.match(mitigated.reason, /No unmitigated 30m POI/);
});

// ---------------------------------------------------------------- check 4
test('check 4: discount entry fires for longs, premium entry does not', () => {
  const range = dealingRange([], { leg: { low: 100, high: 200 } });
  const good = checkPremiumDiscount({ instrument: INSTRUMENT, bias: { direction: 'bullish' }, entryPrice: 120, ltfRange: range, opts: {} });
  assert.equal(good.passed, true);
  assert.match(good.reason, /Entry sits in discount at 20% of the dealing range/);

  const bad = checkPremiumDiscount({ instrument: INSTRUMENT, bias: { direction: 'bullish' }, entryPrice: 180, ltfRange: range, opts: {} });
  assert.equal(bad.passed, false);
  assert.match(bad.reason, /longs want discount/);
});

test('check 4: premium entry fires for shorts', () => {
  const range = dealingRange([], { leg: { low: 100, high: 200 } });
  const good = checkPremiumDiscount({ instrument: INSTRUMENT, bias: { direction: 'bearish' }, entryPrice: 180, ltfRange: range, opts: {} });
  assert.equal(good.passed, true);
  assert.match(good.reason, /Entry sits in premium/);

  const noRange = checkPremiumDiscount({ instrument: INSTRUMENT, bias: { direction: 'bearish' }, entryPrice: 180, ltfRange: null, opts: {} });
  assert.equal(noRange.passed, false);
});

// ---------------------------------------------------------------- check 5
test('check 5: an entry zone overlapping an unmitigated HTF POI fires', () => {
  const r = checkHtfConfluence({
    instrument: INSTRUMENT,
    entryZone: { top: 101, bottom: 100 },
    bias: { direction: 'bullish', pois: [livePoi({ direction: 'bullish', top: 102, bottom: 99.5 })] },
    opts: {},
  });
  assert.equal(r.passed, true);
  assert.equal(r.details.overlap, 1, 'the 30m zone sits entirely inside the 4H zone');
  assert.match(r.reason, /Confluence with an HTF POI/);
});

test('check 5: no overlap, wrong direction, or mitigated HTF POI does not fire', () => {
  const apart = checkHtfConfluence({
    instrument: INSTRUMENT,
    entryZone: { top: 101, bottom: 100 },
    bias: { direction: 'bullish', pois: [livePoi({ direction: 'bullish', top: 99, bottom: 98 })] },
    opts: {},
  });
  assert.equal(apart.passed, false);

  const wrongWay = checkHtfConfluence({
    instrument: INSTRUMENT,
    entryZone: { top: 101, bottom: 100 },
    bias: { direction: 'bullish', pois: [livePoi({ direction: 'bearish', top: 102, bottom: 99.5 })] },
    opts: {},
  });
  assert.equal(wrongWay.passed, false);

  const noZone = checkHtfConfluence({ instrument: INSTRUMENT, entryZone: null, bias: { direction: 'bullish', pois: [] }, opts: {} });
  assert.equal(noZone.passed, false);
});

// ---------------------------------------------------------------- check 6
test('check 6: the displacement candle behind the shift fires', () => {
  const candles = bullishScenario();
  const r = checkDisplacement({
    instrument: INSTRUMENT,
    bias: { direction: 'bullish' },
    ltfCandles: candles,
    ltfStructure: analyzeStructure(candles, STRUCT_OPTS),
    opts: {},
  });
  assert.equal(r.passed, true);
  assert.match(r.reason, /body 3\.2x the 20-period average range/);
  assert.equal(r.details.displacement.index, 19);
});

test('check 6: a drift with no big candle does not fire', () => {
  const candles = noise(30, 100);
  const r = checkDisplacement({
    instrument: INSTRUMENT,
    bias: { direction: 'bullish' },
    ltfCandles: candles,
    ltfStructure: { lastEvent: null },
    opts: {},
  });
  assert.equal(r.passed, false);
  assert.match(r.reason, /No displacement candle/);
});

// ---------------------------------------------------------------- scorer
test('scorer: the bullish scenario scores 5 of 6 with per-check reasons', () => {
  const bias = {
    direction: 'bullish',
    pois: [livePoi({ direction: 'bullish', top: 102, bottom: 100 })],
  };
  const r = scoreSetup({
    instrument: INSTRUMENT,
    bias,
    ltfCandles: bullishScenario(),
    opts: { structure: STRUCT_OPTS },
  });

  assert.equal(r.direction, 'bullish');
  assert.equal(r.score, 5);
  assert.equal(r.total, 6);
  assert.equal(r.passed, true);

  const byId = Object.fromEntries(r.confirmations.map((x) => [x.id, x.passed]));
  assert.deepEqual(byId, {
    ltf_structure: true,
    liquidity_sweep: true,
    poi_retrace: true,
    premium_discount: false, // price retraced into premium of the impulse leg
    htf_confluence: true,
    displacement: true,
  });

  assert.equal(r.reasons.length, 5);
  assert.equal(r.reasons.every((x) => typeof x === 'string' && x.length > 10), true);
  assert.equal(r.entryPoi.kind, 'FVG');
  assert.deepEqual(r.entryZone, { top: 102.8, bottom: 99.8 });
});

test('scorer: entry never uses a level price has already traded through', () => {
  assert.equal(achievableEntry(102.8, 101.5, 'bullish'), 101.5, 'longs take the better, achievable price');
  assert.equal(achievableEntry(102.8, 103.5, 'bullish'), 102.8, 'limit is still ahead of price');
  assert.equal(achievableEntry(99.0, 100.2, 'bearish'), 100.2);
  assert.equal(achievableEntry(99.0, 98.0, 'bearish'), 99.0);

  const r = scoreSetup({
    instrument: INSTRUMENT,
    bias: { direction: 'bullish', pois: [] },
    ltfCandles: bullishScenario(),
    opts: { structure: STRUCT_OPTS },
  });
  assert.equal(r.entryPrice, 101.5);
});

test('scorer: the minimum-confirmation gate is enforced', () => {
  const candles = bullishScenario();
  const bias = { direction: 'bullish', pois: [] };

  const lenient = scoreSetup({ instrument: INSTRUMENT, bias, ltfCandles: candles, opts: { structure: STRUCT_OPTS, scoring: { minConfirmations: 3 } } });
  assert.equal(lenient.passed, true);
  assert.equal(lenient.required, 3);

  const strict = scoreSetup({ instrument: INSTRUMENT, bias, ltfCandles: candles, opts: { structure: STRUCT_OPTS, scoring: { minConfirmations: 6 } } });
  assert.equal(strict.passed, false, '4 of 6 does not clear a 6 requirement');
  assert.equal(strict.score, 4);
});

test('scorer: a neutral bias short-circuits', () => {
  const r = scoreSetup({ instrument: INSTRUMENT, bias: { direction: 'neutral' }, ltfCandles: bullishScenario(), opts: {} });
  assert.equal(r.passed, false);
  assert.equal(r.score, 0);
  assert.deepEqual(r.confirmations, []);
  assert.match(r.reason, /No HTF bias/);
});

test('scorer: every fired confirmation carries a distinct one-line reason', () => {
  const r = scoreSetup({
    instrument: INSTRUMENT,
    bias: { direction: 'bullish', pois: [livePoi({ direction: 'bullish', top: 102, bottom: 100 })] },
    ltfCandles: bullishScenario(),
    opts: { structure: STRUCT_OPTS },
  });
  const reasons = r.fired.map((f) => f.reason);
  assert.equal(new Set(reasons).size, reasons.length, 'no duplicated reasons');
  for (const reason of reasons) {
    assert.equal(reason.includes('\n'), false, 'reasons stay on one line');
  }
});
