'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Scanner } = require('../src/scanner');
const { bullishFiringScenario, bullishHtfScenario, noise } = require('./helpers/candles');

const TEST_INSTRUMENT = {
  id: 'TEST',
  displayName: 'Test Index',
  source: 'deriv',
  symbol: 'T',
  kind: 'synthetic',
  quoteCurrency: 'USD',
  pipSize: 1,
  pricePrecision: 2,
  contractSize: 1,
  slBuffer: 0.5,
  minLot: 0.001,
  lotStep: 0.001,
  maxLot: 50,
  enabled: true,
};

const ENGINE_OPTS = { structure: { swingLookback: 1, breakOnClose: true } };

/** A data service that hands back fixed series regardless of what is asked. */
function fakeData({ htf, ltf, oanda = null } = {}) {
  return {
    oanda,
    getBiasAndEntryCandles: async () => ({ htf, ltf }),
    close() {},
  };
}

function buildScanner(overrides = {}) {
  const sent = [];
  const logged = [];
  const scanner = new Scanner({
    data: fakeData({ htf: bullishHtfScenario(), ltf: bullishFiringScenario() }),
    alerts: {
      deliver: async (alert) => {
        sent.push(alert);
        return { sent: true, message: 'formatted' };
      },
      seedFrom() {},
    },
    db: { logAlert: async (a) => { logged.push(a); return { _id: 'rec1' }; } },
    instruments: [TEST_INSTRUMENT],
    engineOpts: ENGINE_OPTS,
    persist: true,
    ...overrides,
  });
  return { scanner, sent, logged };
}

test('scanner: a qualifying setup runs the whole pipeline and fires', async () => {
  const { scanner, sent, logged } = buildScanner();
  const [result] = await scanner.scanAll();

  assert.equal(result.fired, true);
  assert.equal(result.stage, 'alert');
  assert.equal(result.recordId, 'rec1');

  assert.equal(result.bias.direction, 'bullish');
  assert.equal(result.scoring.score, 6);
  assert.equal(result.scoring.passed, true);

  assert.equal(result.plan.valid, true);
  assert.equal(result.plan.side, 'BUY');
  assert.equal(result.plan.entryPrice, 99.5);
  assert.equal(result.plan.stopPrice, 96.5);
  assert.equal(result.plan.riskReward, 2);
  assert.equal(result.plan.position.lots, 1);
  assert.ok(Math.abs(result.plan.position.actualRiskUsd - 3) < 1e-9, 'risks exactly the $3 budget');

  assert.equal(sent.length, 1);
  assert.equal(logged.length, 1);
  assert.equal(sent[0].confirmations.length, 6, 'all six reasons travel with the alert');
  assert.equal(sent[0].allConfirmations.length, 6);
  assert.ok(sent[0].poiId);
});

test('scanner: a duplicate is not logged twice', async () => {
  const logged = [];
  const { scanner } = buildScanner({
    alerts: {
      deliver: async () => ({ sent: false, skipped: 'duplicate', duplicateOf: {} }),
      seedFrom() {},
    },
    db: { logAlert: async (a) => { logged.push(a); return { _id: 'x' }; } },
  });

  const [result] = await scanner.scanAll();
  assert.equal(result.fired, false);
  assert.equal(result.stage, 'dedup');
  assert.equal(logged.length, 0, 'a suppressed duplicate is not re-persisted');
});

test('scanner: no HTF direction stops before any 30m work', async () => {
  const { scanner, sent } = buildScanner({
    data: fakeData({ htf: noise(40, 100), ltf: bullishFiringScenario() }),
  });
  const [result] = await scanner.scanAll();

  assert.equal(result.fired, false);
  assert.equal(result.stage, 'bias');
  assert.match(result.reason, /no confirmed direction/);
  assert.equal(result.scoring, undefined);
  assert.equal(sent.length, 0);
});

test('scanner: too few confirmations stops before the trade plan', async () => {
  const { scanner, sent } = buildScanner({
    // A quiet 30m series under a valid HTF bias: nothing to confirm.
    data: fakeData({ htf: bullishHtfScenario(), ltf: noise(40, 100) }),
  });
  const [result] = await scanner.scanAll();

  assert.equal(result.fired, false);
  assert.equal(result.stage, 'confirmations');
  assert.match(result.reason, /confirmations, 3 required/);
  assert.ok(result.scoring.score < 3);
  assert.equal(result.plan, undefined);
  assert.equal(sent.length, 0);
});

test('scanner: the R:R gate discards a 6/6 setup when TP1 cannot reach 1:2', async () => {
  const { scanner, sent } = buildScanner({
    // A far wider stop buffer makes the same setup fail the R:R gate outright.
    instruments: [{ ...TEST_INSTRUMENT, slBuffer: 6 }],
  });
  const [result] = await scanner.scanAll();

  assert.equal(result.scoring.score, 6, 'every confirmation still fired');
  assert.equal(result.fired, false);
  assert.equal(result.stage, 'gate:risk_reward');
  assert.match(result.reason, /below the 1:2 minimum/);
  assert.equal(sent.length, 0, 'the confirmation score does not override the gate');
});

test('scanner: a data failure is contained to one instrument', async () => {
  const { scanner } = buildScanner({
    data: {
      oanda: null,
      getBiasAndEntryCandles: async () => {
        throw new Error('feed unavailable');
      },
      close() {},
    },
  });
  const [result] = await scanner.scanAll();
  assert.equal(result.fired, false);
  assert.equal(result.stage, 'error');
  assert.equal(result.reason, 'feed unavailable');
});

test('scanner: empty candle sets are reported, not thrown', async () => {
  const { scanner } = buildScanner({ data: fakeData({ htf: [], ltf: [] }) });
  const [result] = await scanner.scanAll();
  assert.equal(result.stage, 'data');
  assert.match(result.reason, /No candles/);
});

test('scanner: every instrument is scanned even when one fails', async () => {
  let call = 0;
  const { scanner } = buildScanner({
    instruments: [TEST_INSTRUMENT, { ...TEST_INSTRUMENT, id: 'TEST2' }],
    data: {
      oanda: null,
      getBiasAndEntryCandles: async () => {
        call += 1;
        if (call === 1) throw new Error('boom');
        return { htf: bullishHtfScenario(), ltf: bullishFiringScenario() };
      },
      close() {},
    },
  });
  const results = await scanner.scanAll();
  assert.equal(results.length, 2);
  assert.equal(results[0].stage, 'error');
  assert.equal(results[1].fired, true);
});

test('scanner: live cross rates are fetched only for pairs that need them', async () => {
  const asked = [];
  const oanda = {
    configured: true,
    fetchLatestPrice: async (symbol) => {
      asked.push(symbol);
      return 155;
    },
  };
  const { scanner } = buildScanner({
    instruments: [
      TEST_INSTRUMENT, // USD quote — no conversion needed
      { ...TEST_INSTRUMENT, id: 'EURUSD', baseCurrency: 'EUR', quoteCurrency: 'USD' },
      { ...TEST_INSTRUMENT, id: 'USDJPY', baseCurrency: 'USD', quoteCurrency: 'JPY' },
      { ...TEST_INSTRUMENT, id: 'GBPJPY', baseCurrency: 'GBP', quoteCurrency: 'JPY' },
    ],
    data: fakeData({ htf: bullishHtfScenario(), ltf: bullishFiringScenario(), oanda }),
  });

  const rates = await scanner.fetchRates();
  assert.deepEqual(asked, ['USD_JPY'], 'only the GBP/JPY cross needs a rate');
  assert.ok(Math.abs(rates.JPY - 1 / 155) < 1e-12);
});

test('scanner: a rate lookup failure does not stop the scan', async () => {
  const oanda = {
    configured: true,
    fetchLatestPrice: async () => {
      throw new Error('rate feed down');
    },
  };
  const { scanner } = buildScanner({
    instruments: [{ ...TEST_INSTRUMENT, id: 'GBPJPY', baseCurrency: 'GBP', quoteCurrency: 'JPY' }],
    data: fakeData({ htf: bullishHtfScenario(), ltf: bullishFiringScenario(), oanda }),
  });
  assert.deepEqual(await scanner.fetchRates(), {});
  const results = await scanner.scanAll();
  assert.equal(results.length, 1);
});

test('scanner: persistence can be turned off without affecting delivery', async () => {
  const logged = [];
  const { scanner, sent } = buildScanner({
    persist: false,
    db: { logAlert: async (a) => { logged.push(a); return { _id: 'x' }; } },
  });
  const [result] = await scanner.scanAll();
  assert.equal(result.fired, true);
  assert.equal(sent.length, 1);
  assert.equal(logged.length, 0);
  assert.equal(result.recordId, null);
});

test('scanner: per-instrument engine overrides reach the detectors', async () => {
  // The fixture's displacement candle is 3.2x the average range: it clears the
  // global 1.5x bar and the Jump indices' 2.5x bar, but not a 4x one.
  const strict = buildScanner({
    instruments: [{ ...TEST_INSTRUMENT, engine: { displacement: { bodyMultiple: 4 } } }],
  });
  const [tightened] = await strict.scanner.scanAll();
  const dispCheck = tightened.scoring.confirmations.find((c) => c.id === 'displacement');
  assert.equal(dispCheck.passed, false);
  assert.match(dispCheck.reason, /No displacement candle/);
  assert.equal(tightened.scoring.score, 5, 'one fewer confirmation than the unoverridden run');

  const jumpLike = buildScanner({
    instruments: [{ ...TEST_INSTRUMENT, engine: { displacement: { bodyMultiple: 2.5 } } }],
  });
  const [loosened] = await jumpLike.scanner.scanAll();
  assert.equal(loosened.scoring.confirmations.find((c) => c.id === 'displacement').passed, true);
  assert.equal(loosened.scoring.score, 6);
});

test('scanner: an override never leaks into the next instrument', async () => {
  const { scanner } = buildScanner({
    instruments: [
      { ...TEST_INSTRUMENT, id: 'STRICT', engine: { displacement: { bodyMultiple: 4 } } },
      { ...TEST_INSTRUMENT, id: 'PLAIN' },
    ],
  });
  const results = await scanner.scanAll();
  assert.equal(results[0].scoring.score, 5);
  assert.equal(results[1].scoring.score, 6, 'the second instrument uses the global thresholds');
});

test('scanner: a Jump index runs the pipeline with its own thresholds', async () => {
  const jump = {
    ...TEST_INSTRUMENT,
    id: 'JUMP75',
    displayName: 'Jump 75 Index',
    symbol: 'JD75',
    subKind: 'jump',
    slBuffer: { pct: 0.005 }, // 0.5% of a ~99.5 fixture price ~= the 0.5 used elsewhere
    minLot: 0.01,
    lotStep: 0.01,
    engine: {
      displacement: { bodyMultiple: 2.5 },
      poi: { fvg: { minGapFactor: 0.35 }, orderBlocks: { displacementBodyMultiple: 2.5 } },
    },
  };
  const { scanner, sent } = buildScanner({ instruments: [jump] });
  const [result] = await scanner.scanAll();

  assert.equal(result.fired, true);
  assert.equal(result.plan.side, 'BUY');
  assert.ok(Math.abs(result.plan.stopBuffer - 99.5 * 0.005) < 1e-9, 'the pct buffer resolved off the entry price');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].instrument.id, 'JUMP75');
});

// ---------------------------------------------------------------- edge gate
const { EdgeProfile } = require('../src/backtest/edgeProfile');

function profileWith(rules, validated = true) {
  return new EdgeProfile({
    version: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    validated,
    rules: {
      minScore: null,
      requiredConfirmations: [],
      minBiasStrength: null,
      disabledInstruments: [],
      allowedDirections: null,
      ...rules,
    },
  });
}

test('scanner: the edge profile blocks a setup that clears every structural gate', async () => {
  const { scanner, sent, logged } = buildScanner({
    // The fixture scores 6/6, so a minimum of 7 can never be met.
    edgeProfile: profileWith({ minScore: 7 }),
  });
  const [result] = await scanner.scanAll();

  assert.equal(result.scoring.score, 6, 'the setup itself was valid');
  assert.equal(result.plan.valid, true, 'and it cleared the R:R gate');
  assert.equal(result.fired, false);
  assert.equal(result.stage, 'gate:edge');
  assert.match(result.reason, /below the backtested minimum of 7/);
  assert.equal(sent.length, 0, 'nothing was sent');
  assert.equal(logged.length, 0, 'and nothing was logged');
});

test('scanner: a matching setup passes the edge profile and carries the reason', async () => {
  const { scanner, sent } = buildScanner({
    edgeProfile: profileWith({ minScore: 5, requiredConfirmations: ['liquidity_sweep'] }),
  });
  const [result] = await scanner.scanAll();

  assert.equal(result.fired, true);
  assert.equal(sent[0].edgeProfile.matched, true);
  assert.equal(sent[0].edgeProfile.active, true);
  assert.match(sent[0].edgeProfile.reason, /Matches the backtested profile/);
});

test('scanner: a required confirmation the setup lacks blocks the alert', async () => {
  // The fixture fires all six, so require something outside that set.
  const { scanner } = buildScanner({
    edgeProfile: profileWith({ minScore: 3, requiredConfirmations: ['not_a_real_check'] }),
  });
  const [result] = await scanner.scanAll();
  assert.equal(result.stage, 'gate:edge');
  assert.match(result.reason, /Missing confirmation/);
});

test('scanner: an instrument the backtest disabled never alerts', async () => {
  const { scanner } = buildScanner({ edgeProfile: profileWith({ disabledInstruments: ['TEST'] }) });
  const [result] = await scanner.scanAll();
  assert.equal(result.stage, 'gate:edge');
  assert.match(result.reason, /showed no edge in the backtest/);
});

test('scanner: an unvalidated profile does not filter anything', async () => {
  const { scanner, sent } = buildScanner({ edgeProfile: profileWith({ minScore: 7 }, false) });
  const [result] = await scanner.scanAll();
  assert.equal(result.fired, true, 'rules that failed their holdout are not enforced');
  assert.equal(sent.length, 1);
});

test('scanner: with no profile at all, behaviour is unchanged', async () => {
  const { scanner, sent } = buildScanner({ edgeProfile: new EdgeProfile(null) });
  const [result] = await scanner.scanAll();
  assert.equal(result.fired, true);
  assert.equal(sent.length, 1);
});
