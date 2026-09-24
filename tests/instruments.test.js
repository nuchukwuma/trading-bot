'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { INSTRUMENTS, byId, enabledInstruments } = require('../src/config/instruments');
const { resolveStopBuffer, buildTradePlan, calculatePositionSize } = require('../src/tradeplan');
const { mergeEngineOpts } = require('../src/scanner');

const JUMP_IDS = ['JUMP10', 'JUMP25', 'JUMP50', 'JUMP75', 'JUMP100'];

test('registry: all five Jump indices are present and routed to Deriv', () => {
  for (const id of JUMP_IDS) {
    const i = byId(id);
    assert.ok(i, `${id} missing`);
    assert.equal(i.source, 'deriv');
    assert.equal(i.kind, 'synthetic');
    assert.equal(i.subKind, 'jump');
    assert.equal(i.quoteCurrency, 'USD');
    assert.equal(i.symbol, `JD${id.replace('JUMP', '')}`);
    assert.equal(i.enabled, true);
  }
  assert.deepEqual(enabledInstruments(JUMP_IDS).map((i) => i.id), JUMP_IDS);
});

test('registry: Jump entries are flagged uncalibrated so the estimates are visible', () => {
  for (const id of JUMP_IDS) assert.equal(byId(id).calibrated, false);
  // The instruments checked against a live feed carry no such flag.
  assert.equal(byId('VOL75').calibrated, undefined);
  assert.equal(byId('EURUSD').calibrated, undefined);
});

test('registry: the Jump stop buffer scales with the volatility in the name', () => {
  const pcts = JUMP_IDS.map((id) => byId(id).slBuffer.pct);
  assert.deepEqual(pcts, [0.0002, 0.0005, 0.001, 0.0015, 0.002]);
  for (let i = 1; i < pcts.length; i += 1) {
    assert.ok(pcts[i] > pcts[i - 1], 'a higher volatility index gets a wider buffer');
  }
  // Anchored on Volatility 75: 0.15% of a ~100k index level is the 150 used there.
  assert.ok(Math.abs(byId('JUMP75').slBuffer.pct * 100000 - byId('VOL75').slBuffer) < 1e-9);
});

test('registry: Jump indices carry engine overrides for the jump process', () => {
  for (const id of JUMP_IDS) {
    const e = byId(id).engine;
    assert.equal(e.displacement.bodyMultiple, 2.5, 'a jump alone must not count as displacement');
    assert.equal(e.poi.fvg.minGapFactor, 0.35, 'jumps leave gaps on their own');
    assert.equal(e.poi.orderBlocks.displacementBodyMultiple, 2.5);
  }
  assert.equal(byId('VOL75').engine, undefined, 'the other synthetics use the global thresholds');
});

test('registry: every instrument has the fields the sizing maths needs', () => {
  for (const i of INSTRUMENTS) {
    assert.ok(i.id && i.displayName && i.symbol, `${i.id} is missing identity fields`);
    assert.ok(Number.isFinite(i.contractSize) && i.contractSize > 0, `${i.id} contractSize`);
    assert.ok(Number.isFinite(i.pipSize) && i.pipSize > 0, `${i.id} pipSize`);
    assert.ok(Number.isFinite(i.minLot) && Number.isFinite(i.lotStep) && Number.isFinite(i.maxLot), `${i.id} lots`);
    assert.ok(i.minLot <= i.maxLot, `${i.id} lot bounds`);
    assert.ok(resolveStopBuffer(i.slBuffer, 100) !== null, `${i.id} slBuffer is unusable`);
  }
});

// ------------------------------------------------------- buffer resolution
test('buffer: a number is already in price units', () => {
  assert.equal(resolveStopBuffer(150, 100000), 150);
  assert.equal(resolveStopBuffer(0.0006, 1.1), 0.0006);
});

test('buffer: a pct buffer is a fixed fraction of the entry price', () => {
  assert.equal(resolveStopBuffer({ pct: 0.0015 }, 100000), 150);
  assert.equal(resolveStopBuffer({ pct: 0.0015 }, 20000), 30);
  // It scales with the index level but never with volatility — the same price
  // always yields the same buffer, whatever the candles have been doing.
  assert.equal(resolveStopBuffer({ pct: 0.002 }, 5000), resolveStopBuffer({ pct: 0.002 }, 5000));
});

test('buffer: unusable configurations are rejected rather than silently zeroed', () => {
  assert.equal(resolveStopBuffer(0, 100), null);
  assert.equal(resolveStopBuffer(-5, 100), null);
  assert.equal(resolveStopBuffer({ pct: 0 }, 100), null);
  assert.equal(resolveStopBuffer(undefined, 100), null);
  assert.equal(resolveStopBuffer({ pct: 0.001 }, 0), null);
});

test('plan: a Jump index sizes correctly through a pct buffer', () => {
  const jump75 = byId('JUMP75');
  // At an index level of 100,000 the 0.15% buffer resolves to 150 points.
  const plan = buildTradePlan({
    instrument: jump75,
    direction: 'bullish',
    entryPrice: 100000,
    poi: { direction: 'bullish', top: 100100, bottom: 99900 },
    sweep: { extreme: 99800 },
  });

  assert.equal(plan.valid, true);
  assert.equal(plan.stopBuffer, 150);
  assert.equal(plan.stopPrice, 99650);
  assert.equal(plan.riskDistance, 350);
  assert.equal(plan.riskReward, 2);

  // $1 per point per lot, 350 point stop -> 3/350 = 0.00857, floored to the
  // 0.01 lot step this instrument uses, which is below the minimum.
  assert.equal(plan.position.lots, jump75.minLot);
  assert.equal(plan.position.belowMinimum, true);
  assert.match(plan.warnings[0], /too wide for a \$3 risk/);
});

test('plan: the same pct buffer follows the index level', () => {
  const atLowLevel = buildTradePlan({
    instrument: byId('JUMP25'),
    direction: 'bullish',
    entryPrice: 10000,
    poi: { direction: 'bullish', top: 10010, bottom: 9990 },
    sweep: { extreme: 9980 },
  });
  assert.equal(atLowLevel.stopBuffer, 5, '0.05% of 10,000');

  const atHighLevel = buildTradePlan({
    instrument: byId('JUMP25'),
    direction: 'bullish',
    entryPrice: 40000,
    poi: { direction: 'bullish', top: 40010, bottom: 39990 },
    sweep: { extreme: 39980 },
  });
  assert.equal(atHighLevel.stopBuffer, 20, 'the buffer tracks a 4x index level, not volatility');
});

test('plan: an instrument with an unusable buffer is rejected, not defaulted', () => {
  const broken = { ...byId('JUMP75'), slBuffer: { pct: 0 } };
  const plan = buildTradePlan({
    instrument: broken,
    direction: 'bullish',
    entryPrice: 100000,
    poi: { direction: 'bullish', top: 100100, bottom: 99900 },
    sweep: { extreme: 99800 },
  });
  assert.equal(plan.valid, false);
  assert.equal(plan.gate, 'config');
  assert.match(plan.reason, /no usable slBuffer/);
});

test('sizing: a Jump index prices a point move like the volatility indices', () => {
  const r = calculatePositionSize({
    instrument: byId('JUMP50'),
    entryPrice: 20000,
    stopPrice: 19900,
    riskUsd: 3,
  });
  assert.equal(r.stopDistance, 100);
  assert.equal(r.riskPerLotUsd, 100, '$1 per point per lot');
  assert.equal(r.quoteUsdSource, 'quote-is-usd');
  assert.equal(r.lots, 0.03);
});

// ------------------------------------------------------- override merging
test('overrides: per-instrument engine options merge one level deep', () => {
  const base = {
    structure: { swingLookback: 2, breakOnClose: true },
    displacement: { bodyMultiple: 1.5, avgPeriod: 20 },
  };
  const merged = mergeEngineOpts(base, { displacement: { bodyMultiple: 2.5 } });

  assert.deepEqual(merged.structure, { swingLookback: 2, breakOnClose: true }, 'untouched sections survive');
  assert.deepEqual(merged.displacement, { bodyMultiple: 2.5, avgPeriod: 20 }, 'siblings are kept');
  assert.deepEqual(base.displacement, { bodyMultiple: 1.5, avgPeriod: 20 }, 'the base is not mutated');
});

test('overrides: nested sections merge, and no override is a no-op', () => {
  const base = { poi: { maxTracked: 10, fvg: { minGapFactor: 0.1, requireDisplacement: false } } };
  const merged = mergeEngineOpts(base, { poi: { fvg: { minGapFactor: 0.35 } } });

  assert.equal(merged.poi.maxTracked, 10);
  assert.equal(merged.poi.fvg.minGapFactor, 0.35);
  assert.equal(merged.poi.fvg.requireDisplacement, false, 'sibling keys inside a nested section survive');

  assert.deepEqual(mergeEngineOpts(base, undefined), base);
  assert.deepEqual(mergeEngineOpts(base, {}), base);
  assert.deepEqual(mergeEngineOpts({}, { a: 1 }), { a: 1 });
});

test('overrides: a scalar override replaces rather than merges', () => {
  assert.deepEqual(mergeEngineOpts({ a: { b: 1 } }, { a: 5 }), { a: 5 });
});

// ------------------------------------------------------- forex source
const { resolveForexSource, FOREX_SOURCES } = require('../src/config/instruments');
const { usdPairSymbol } = require('../src/scanner');

const FOREX_IDS = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'GBPJPY'];

test('forex: Deriv is the default source, with frx symbols', () => {
  for (const id of FOREX_IDS) {
    const i = byId(id);
    assert.equal(i.source, 'deriv');
    assert.equal(i.symbol, `frx${id}`);
    assert.equal(i.marketHours, 'forex', 'forex is flagged as a market that closes');
  }
});

test('forex: every pair carries a symbol for every supported feed', () => {
  for (const id of FOREX_IDS) {
    for (const source of FOREX_SOURCES) {
      assert.ok(byId(id).symbols[source], `${id} has no ${source} symbol`);
    }
  }
});

test('forex: switching to OANDA changes only the source and symbol', () => {
  const deriv = byId('USDJPY');
  const oanda = resolveForexSource(deriv, 'oanda');
  assert.equal(oanda.source, 'oanda');
  assert.equal(oanda.symbol, 'USD_JPY');
  for (const field of ['pipSize', 'pricePrecision', 'contractSize', 'slBuffer', 'minLot', 'quoteCurrency']) {
    assert.deepEqual(oanda[field], deriv[field], `${field} must not depend on the feed`);
  }
});

test('forex: an unknown source fails loudly instead of silently scanning nothing', () => {
  assert.throws(() => resolveForexSource(byId('EURUSD'), 'exness'), /FOREX_SOURCE must be one of deriv, oanda/);
  assert.equal(resolveForexSource(byId('EURUSD'), 'DERIV').source, 'deriv', 'case-insensitive');
});

test('forex: the USD pair used for cross-rate conversion follows each feed’s naming', () => {
  assert.equal(usdPairSymbol('deriv', 'JPY'), 'frxUSDJPY');
  assert.equal(usdPairSymbol('oanda', 'JPY'), 'USD_JPY');
  assert.equal(usdPairSymbol('nowhere', 'JPY'), null);
});
