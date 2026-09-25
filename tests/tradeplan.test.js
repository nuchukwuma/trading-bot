'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { calculatePositionSize, quoteToUsd } = require('../src/tradeplan/positionSize');
const { buildTargets, managementSteps, validateLadder } = require('../src/tradeplan/targets');
const { buildTradePlan, resolveStopAnchor, resolveObstacle } = require('../src/tradeplan');
const { byId } = require('../src/config/instruments');

const VOL75 = byId('VOL75');
const EURUSD = byId('EURUSD');
const USDJPY = byId('USDJPY');
const GBPJPY = byId('GBPJPY');

// ------------------------------------------------------------ conversion
test('sizing: quote-to-USD conversion handles all three pair shapes', () => {
  assert.deepEqual(quoteToUsd(VOL75, 100000), { rate: 1, source: 'quote-is-usd' });
  assert.deepEqual(quoteToUsd(EURUSD, 1.1), { rate: 1, source: 'quote-is-usd' });

  const jpy = quoteToUsd(USDJPY, 150);
  assert.equal(jpy.source, 'inverse-of-price');
  assert.ok(Math.abs(jpy.rate - 1 / 150) < 1e-12);

  const live = quoteToUsd(GBPJPY, 190, { JPY: 1 / 155 });
  assert.equal(live.source, 'live-rate');
  assert.ok(Math.abs(live.rate - 1 / 155) < 1e-12);

  const fallback = quoteToUsd(GBPJPY, 190);
  assert.equal(fallback.source, 'configured-fallback');

  assert.equal(quoteToUsd({ quoteCurrency: 'XYZ', baseCurrency: 'GBP' }, 1).rate, null);
  assert.equal(quoteToUsd(USDJPY, 0).rate, null, 'cannot invert a zero price');
});

// ------------------------------------------------------------ sizing maths
test('sizing: synthetic index sizes from $1 per point per lot', () => {
  // 150 point stop, $1/point/lot -> $150 risk per lot -> 3/150 = 0.02 lots
  const r = calculatePositionSize({ instrument: VOL75, entryPrice: 100000, stopPrice: 99850, riskUsd: 3 });
  assert.equal(r.valid, true);
  assert.equal(r.lots, 0.02);
  assert.equal(r.stopDistance, 150);
  assert.ok(Math.abs(r.actualRiskUsd - 3) < 1e-9);
  assert.equal(r.belowMinimum, false);
  assert.deepEqual(r.warnings, []);
});

test('sizing: USD-quoted forex sizes from $10 per pip per lot', () => {
  // 6 pip stop -> $60 per lot -> 3/60 = 0.05 lots
  const r = calculatePositionSize({ instrument: EURUSD, entryPrice: 1.1, stopPrice: 1.0994, riskUsd: 3 });
  assert.equal(r.lots, 0.05);
  assert.ok(Math.abs(r.stopDistancePips - 6) < 1e-9);
  assert.ok(Math.abs(r.actualRiskUsd - 3) < 1e-9);
});

test('sizing: a JPY-quoted pair converts through the price, not 10 USD per pip', () => {
  // 8 pip stop = 0.08 JPY; per lot = 100000 * 0.08 = 8000 JPY = $53.33 at 150
  const r = calculatePositionSize({ instrument: USDJPY, entryPrice: 150, stopPrice: 149.92, riskUsd: 3 });
  assert.ok(Math.abs(r.riskPerLotUsd - 8000 / 150) < 1e-6);
  assert.equal(r.lots, 0.05);
  assert.ok(r.actualRiskUsd <= 3, 'flooring never over-risks');
  assert.ok(Math.abs(r.actualRiskUsd - 2.6667) < 1e-3);
});

test('sizing: a cross pair falls back to the configured rate and says so', () => {
  const r = calculatePositionSize({ instrument: GBPJPY, entryPrice: 190, stopPrice: 189.86, riskUsd: 3 });
  assert.equal(r.quoteUsdSource, 'configured-fallback');
  assert.match(r.warnings[0], /fallback rate, not a live one/);

  const live = calculatePositionSize({ instrument: GBPJPY, entryPrice: 190, stopPrice: 189.86, riskUsd: 3, rates: { JPY: 1 / 155 } });
  assert.equal(live.quoteUsdSource, 'live-rate');
  assert.deepEqual(live.warnings, []);
});

test('sizing: rounding always floors to the lot step so risk is never exceeded', () => {
  const r = calculatePositionSize({ instrument: EURUSD, entryPrice: 1.1, stopPrice: 1.09943, riskUsd: 3 });
  assert.ok(r.rawLots > r.lots, 'raw size was rounded down');
  assert.equal(r.lots % EURUSD.lotStep < 1e-9 || Math.abs((r.lots % EURUSD.lotStep) - EURUSD.lotStep) < 1e-9, true);
  assert.ok(r.actualRiskUsd <= 3 + 1e-9);
});

test('sizing: a stop too wide for the account is flagged, not silently accepted', () => {
  // 60 pip stop on EUR/USD = $600 per lot -> 0.005 lots, under the 0.01 minimum
  const r = calculatePositionSize({ instrument: EURUSD, entryPrice: 1.1, stopPrice: 1.094, riskUsd: 3 });
  assert.equal(r.belowMinimum, true);
  assert.equal(r.lots, EURUSD.minLot);
  assert.ok(r.actualRiskUsd > 3);
  assert.match(r.warnings[0], /too wide for a \$3 risk/);
  assert.match(r.warnings[1], /Actual risk is \$6\.00, above the \$3\.00 target/);
});

test('sizing: size is capped at the broker maximum', () => {
  const tiny = { ...VOL75, maxLot: 0.005 };
  const r = calculatePositionSize({ instrument: tiny, entryPrice: 100000, stopPrice: 99850, riskUsd: 3 });
  assert.equal(r.lots, 0.005);
  assert.match(r.warnings[0], /capped at the 0.005 lot maximum/);
});

test('sizing: a zero stop distance or unknown currency is rejected', () => {
  const zero = calculatePositionSize({ instrument: VOL75, entryPrice: 100, stopPrice: 100, riskUsd: 3 });
  assert.equal(zero.valid, false);
  assert.match(zero.warnings[0], /Stop distance is zero/);

  const unknown = calculatePositionSize({
    instrument: { ...EURUSD, quoteCurrency: 'XYZ', baseCurrency: 'GBP' },
    entryPrice: 1.1,
    stopPrice: 1.09,
    riskUsd: 3,
  });
  assert.equal(unknown.valid, false);
  assert.match(unknown.warnings[0], /No USD conversion available for XYZ/);
});

// ------------------------------------------------------------ targets
test('targets: the nominal ladder is 2R / 3.5R / 5R with 50-30-20 partials', () => {
  const t = buildTargets({ direction: 'bullish', entryPrice: 100, riskDistance: 10 });
  assert.deepEqual(t.map((x) => x.price), [120, 135, 150]);
  assert.deepEqual(t.map((x) => x.closePct), [50, 30, 20]);
  assert.deepEqual(t.map((x) => x.remainingPct), [50, 20, 0]);
  assert.equal(t[0].moveStopToBreakeven, true);
  assert.equal(t[1].trailToStructure, true);
  assert.deepEqual(t.map((x) => x.rr), [2, 3.5, 5]);
});

test('targets: shorts mirror below the entry', () => {
  const t = buildTargets({ direction: 'bearish', entryPrice: 100, riskDistance: 10 });
  assert.deepEqual(t.map((x) => x.price), [80, 65, 50]);
});

test('targets: an obstacle closer than a nominal level caps that target', () => {
  const obstacle = { price: 140, kind: 'EQH', count: 2, source: 'liquidity' };
  const t = buildTargets({ direction: 'bullish', entryPrice: 100, riskDistance: 10, obstacle });

  assert.equal(t[0].price, 120, 'TP1 is nearer than the obstacle, so it is untouched');
  assert.equal(t[0].cappedBy, null);
  assert.equal(t[1].price, 135, 'TP2 is also nearer');
  assert.equal(t[2].price, 140, 'TP3 is pulled back to the liquidity pool');
  assert.equal(t[2].rr, 4);
  assert.equal(t[2].cappedBy, obstacle);
});

test('targets: an obstacle inside 2R drags TP1 R:R under the gate', () => {
  const t = buildTargets({
    direction: 'bullish',
    entryPrice: 100,
    riskDistance: 10,
    obstacle: { price: 112, kind: 'EQH', count: 3, source: 'liquidity' },
  });
  assert.equal(t[0].price, 112);
  assert.ok(Math.abs(t[0].rr - 1.2) < 1e-9);
  assert.equal(t[0].nominalRr, 2, 'the configured intent is still reported');
});

test('targets: an obstacle behind the entry is ignored', () => {
  const t = buildTargets({
    direction: 'bullish',
    entryPrice: 100,
    riskDistance: 10,
    obstacle: { price: 95, kind: 'swing', source: 'liquidity' },
  });
  assert.deepEqual(t.map((x) => x.price), [120, 135, 150]);
});

test('targets: management steps read as instructions and the ladder closes 100%', () => {
  const t = buildTargets({ direction: 'bullish', entryPrice: 100, riskDistance: 10 });
  const steps = managementSteps(t, (n) => n.toFixed(2));
  assert.match(steps[0], /TP1 at 120\.00 \(2\.00R\) — close 50%, move stop to breakeven, 50% left running/);
  assert.match(steps[1], /trail the stop behind 30m structure/);
  assert.match(steps[2], /close 20%$/);

  assert.deepEqual(validateLadder(), { valid: true, total: 100 });
  assert.deepEqual(validateLadder([{ rr: 2, closePct: 60 }]), { valid: false, total: 60 });
});

// ------------------------------------------------------------ stop anchor
test('stop anchor: the further of the sweep wick and the POI far edge wins', () => {
  const poi = { direction: 'bullish', top: 100.5, bottom: 99.5 };
  assert.equal(resolveStopAnchor({ direction: 'bullish', poi, sweep: { extreme: 99.0 }, entryPrice: 100 }), 99.0);
  assert.equal(resolveStopAnchor({ direction: 'bullish', poi, sweep: { extreme: 99.8 }, entryPrice: 100 }), 99.5);
  assert.equal(resolveStopAnchor({ direction: 'bullish', poi, sweep: null, entryPrice: 100 }), 99.5);
  assert.equal(resolveStopAnchor({ direction: 'bullish', poi: null, sweep: { extreme: 99 }, entryPrice: 100 }), 99);
  assert.equal(resolveStopAnchor({ direction: 'bullish', poi: null, sweep: null, entryPrice: 100 }), null);

  const supply = { direction: 'bearish', top: 100.5, bottom: 99.5 };
  assert.equal(resolveStopAnchor({ direction: 'bearish', poi: supply, sweep: { extreme: 101.2 }, entryPrice: 100 }), 101.2);
});

test('stop anchor: candidates on the wrong side of entry are only a last resort', () => {
  // Both anchors sit above a long entry — degenerate, but must not return null.
  const anchor = resolveStopAnchor({
    direction: 'bullish',
    poi: { direction: 'bullish', top: 105, bottom: 104 },
    sweep: { extreme: 103 },
    entryPrice: 100,
  });
  assert.equal(anchor, 103);
});

// ------------------------------------------------------------ obstacles
test('obstacle: the nearest of liquidity and an opposing POI is chosen', () => {
  const swings = [
    { type: 'high', index: 1, price: 130 },
    { type: 'high', index: 5, price: 160 },
  ];
  const opposingPois = [{ direction: 'bearish', kind: 'OB', top: 126, bottom: 125, mitigated: false, violated: false, timeframe: '4h' }];

  const o = resolveObstacle({ swings, opposingPois }, 100, 'bullish');
  assert.equal(o.price, 125, 'the opposing supply zone is nearer than the 130 swing');
  assert.equal(o.source, 'poi');

  const noPoi = resolveObstacle({ swings }, 100, 'bullish');
  assert.equal(noPoi.price, 130);
  assert.equal(noPoi.source, 'liquidity');

  assert.equal(resolveObstacle({}, 100, 'bullish'), null);
  assert.equal(resolveObstacle({ obstacle: null, swings }, 100, 'bullish'), null, 'an explicit null disables it');
});

test('obstacle: mitigated or wrong-side opposing POIs are ignored', () => {
  const opposingPois = [
    { direction: 'bearish', kind: 'OB', top: 126, bottom: 125, mitigated: true, violated: false },
    { direction: 'bearish', kind: 'OB', top: 96, bottom: 95, mitigated: false, violated: false },
    { direction: 'bullish', kind: 'OB', top: 120, bottom: 119, mitigated: false, violated: false },
  ];
  assert.equal(resolveObstacle({ opposingPois }, 100, 'bullish'), null);
});

// ------------------------------------------------------------ full plan
test('plan: a clean long produces entry, stop, three targets and a size', () => {
  const plan = buildTradePlan({
    instrument: VOL75,
    direction: 'bullish',
    entryPrice: 100000,
    poi: { direction: 'bullish', top: 100100, bottom: 99900 },
    sweep: { extreme: 99800 },
  });

  assert.equal(plan.valid, true);
  assert.equal(plan.side, 'BUY');
  assert.equal(plan.stopAnchor, 99800);
  assert.equal(plan.stopPrice, 99800 - VOL75.slBuffer);
  assert.equal(plan.riskDistance, 350);
  assert.equal(plan.targets.length, 3);
  assert.equal(plan.targets[0].price, 100000 + 700);
  assert.equal(plan.riskReward, 2);
  assert.equal(plan.position.lots > 0, true);
  assert.match(plan.summary, /^BUY VOL75 @ 100000\.0000 \| SL 99650\.0000 \(350 pts\) \| 0\.008 lots/);
  assert.equal(plan.management.length, 3);
});

test('plan: the stop buffer is fixed per instrument, not ATR-scaled', () => {
  const tight = buildTradePlan({
    instrument: VOL75,
    direction: 'bullish',
    entryPrice: 100000,
    poi: { direction: 'bullish', top: 100100, bottom: 99900 },
    sweep: { extreme: 99800 },
  });
  const wide = buildTradePlan({
    instrument: VOL75,
    direction: 'bullish',
    entryPrice: 100000,
    poi: { direction: 'bullish', top: 100100, bottom: 99900 },
    sweep: { extreme: 99800 },
    slBuffer: 400,
  });
  assert.equal(tight.stopBuffer, VOL75.slBuffer);
  assert.equal(wide.stopBuffer, 400);
  assert.equal(wide.stopPrice, 99400);
});

test('plan: a short mirrors the long', () => {
  const plan = buildTradePlan({
    instrument: VOL75,
    direction: 'bearish',
    entryPrice: 100000,
    poi: { direction: 'bearish', top: 100100, bottom: 99900 },
    sweep: { extreme: 100200 },
  });
  assert.equal(plan.side, 'SELL');
  assert.equal(plan.stopPrice, 100200 + VOL75.slBuffer);
  assert.equal(plan.riskDistance, 350);
  assert.equal(plan.targets[0].price, 100000 - 700);
  assert.ok(plan.targets[2].price < plan.targets[0].price);
});

test('plan: the hard R:R gate discards a setup whose TP1 cannot reach 1:2', () => {
  const plan = buildTradePlan({
    instrument: VOL75,
    direction: 'bullish',
    entryPrice: 100000,
    poi: { direction: 'bullish', top: 100100, bottom: 99900 },
    sweep: { extreme: 99800 },
    // Resting liquidity only 400 points away — TP1 can only make 1:1.14
    obstacle: { price: 100400, kind: 'EQH', count: 3, source: 'liquidity' },
  });

  assert.equal(plan.valid, false);
  assert.equal(plan.rejected, true);
  assert.equal(plan.gate, 'risk_reward');
  assert.match(plan.reason, /TP1 R:R is 1:1\.14, below the 1:2 minimum \(capped by EQH liquidity \(3\) at 100400/);
  assert.equal(plan.position, undefined, 'a rejected setup is never sized');
});

test('plan: a setup exactly at the 1:2 threshold is allowed through', () => {
  const plan = buildTradePlan({
    instrument: VOL75,
    direction: 'bullish',
    entryPrice: 100000,
    poi: { direction: 'bullish', top: 100100, bottom: 99900 },
    sweep: { extreme: 99800 },
    obstacle: { price: 100700, kind: 'EQH', count: 2, source: 'liquidity' },
  });
  assert.equal(plan.valid, true);
  assert.equal(plan.riskReward, 2);
  assert.equal(plan.targets[2].price, 100700, 'TP3 pulled back to the pool');
});

test('plan: TP3 falls back to the liquidity pool when it is closer than 5R', () => {
  const plan = buildTradePlan({
    instrument: VOL75,
    direction: 'bullish',
    entryPrice: 100000,
    poi: { direction: 'bullish', top: 100100, bottom: 99900 },
    sweep: { extreme: 99800 },
    swings: [{ type: 'high', index: 3, price: 101500 }],
  });
  assert.equal(plan.targets[2].price, 101500);
  assert.ok(plan.targets[2].rr < 5);
  assert.equal(plan.targets[2].cappedBy.source, 'liquidity');
});

test('plan: missing inputs are rejected with a named gate', () => {
  const noEntry = buildTradePlan({ instrument: VOL75, direction: 'bullish', entryPrice: NaN });
  assert.equal(noEntry.gate, 'entry');

  const noAnchor = buildTradePlan({ instrument: VOL75, direction: 'bullish', entryPrice: 100, poi: null, sweep: null });
  assert.equal(noAnchor.gate, 'stop');
  assert.match(noAnchor.reason, /No sweep or POI to anchor/);

  const badLadder = buildTradePlan({
    instrument: VOL75,
    direction: 'bullish',
    entryPrice: 100000,
    poi: { direction: 'bullish', top: 100100, bottom: 99900 },
    sweep: { extreme: 99800 },
    opts: { targets: [{ name: 'TP1', rr: 2, closePct: 90 }] },
  });
  assert.equal(badLadder.gate, 'config');
});

test('plan: forex sizing flows through end to end', () => {
  const plan = buildTradePlan({
    instrument: EURUSD,
    direction: 'bullish',
    entryPrice: 1.1,
    poi: { direction: 'bullish', top: 1.1005, bottom: 1.0996 },
    sweep: { extreme: 1.0994 },
  });
  assert.equal(plan.valid, true);
  assert.ok(Math.abs(plan.stopPrice - 1.0988) < 1e-9, 'sweep low minus the 6 pip buffer');
  assert.ok(Math.abs(plan.riskDistance - 0.0012) < 1e-9);
  assert.equal(plan.position.lots, 0.02);
  assert.match(plan.riskDistanceLabel, /12\.0 pips/);
  assert.match(plan.summary, /^BUY EURUSD @ 1\.10000 \| SL 1\.09880/);
});

test('plan: a learned stop scale moves the stop and targets but keeps the dollar risk', () => {
  const input = {
    instrument: VOL75,
    direction: 'bullish',
    entryPrice: 100000,
    poi: { direction: 'bullish', top: 100100, bottom: 99900 },
    sweep: { extreme: 99800 },
  };
  const base = buildTradePlan(input);
  const wider = buildTradePlan({
    ...input,
    opts: { stopScale: 1.5, targets: require('../src/learn/planVariants').scaledLadder(2.5) },
  });
  assert.equal(wider.baseRiskDistance, 350);
  assert.equal(wider.riskDistance, 525);
  assert.equal(wider.stopPrice, 100000 - 525);
  assert.equal(wider.targets[0].price, 100000 + 525 * 2.5);
  assert.ok(wider.position.lots < base.position.lots, 'a wider stop means a smaller size');
  assert.ok(Math.abs(wider.position.actualRiskUsd - base.position.actualRiskUsd) < 0.5);
});
