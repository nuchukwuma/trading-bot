'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { randomWalkSeries } = require('../src/backtest/randomWalk');
const { replayInstrument } = require('../src/backtest/replay');
const { selectProfile } = require('../src/backtest/analyze');

/**
 * End-to-end calibration of the backtest harness itself.
 *
 * A random walk has no structure to find. Running the whole pipeline over one
 * is the only check that catches a harness which manufactures edge — through
 * look-ahead, optimistic candle resolution, or a selector that fits noise.
 * An earlier version of the selector produced a "validated" profile claiming
 * +0.48R on exactly this data; these tests exist so that cannot come back.
 */

const INSTRUMENT = {
  id: 'SYN',
  displayName: 'Synthetic',
  source: 'deriv',
  symbol: 'SYN',
  kind: 'synthetic',
  quoteCurrency: 'USD',
  pipSize: 1,
  pricePrecision: 2,
  contractSize: 1,
  slBuffer: { pct: 0.002 },
  minLot: 0.001,
  lotStep: 0.001,
  maxLot: 50,
};

const REPLAY_OPTS = { warmupBars: 120, tailBars: 96, simulator: { maxBars: 96 } };

function run(opts) {
  const { ltf, htf } = randomWalkSeries(opts);
  return replayInstrument({ instrument: INSTRUMENT, htf, ltf, opts: REPLAY_OPTS });
}

test('harness: a driftless random walk yields no tradeable edge', { timeout: 60000 }, () => {
  const { trades } = run({ bars: 3000, seed: 21 });
  assert.ok(trades.length > 50, `need a real sample, got ${trades.length}`);

  const selection = selectProfile(trades, { minSamples: 30 });

  // Expectancy on no-edge data should sit around zero. A large positive value
  // means the simulator is resolving ambiguous candles in the trade's favour.
  assert.ok(
    Math.abs(selection.unfilteredAll.expectancy) < 0.5,
    `expectancy ${selection.unfilteredAll.expectancy} is too far from zero for random data`
  );
  assert.equal(selection.validated, false, 'no profile may be validated on structureless data');
});

test('harness: the guards hold across several random seeds', { timeout: 120000 }, () => {
  for (const seed of [31, 32]) {
    const { trades } = run({ bars: 2600, seed });
    const selection = selectProfile(trades, { minSamples: 30 });
    assert.equal(selection.validated, false, `seed ${seed} produced a validated profile from noise`);
  }
});

test('harness: a genuine trend IS detected, so the guards are not simply blind', { timeout: 60000 }, () => {
  const { trades } = run({ bars: 3000, seed: 21, drift: 0.0015 });
  assert.ok(trades.length > 50);

  const selection = selectProfile(trades, { minSamples: 30 });
  assert.ok(
    selection.unfilteredAll.expectancy > 0.5,
    `a strongly trending market should show positive expectancy, got ${selection.unfilteredAll.expectancy}`
  );
  assert.ok(selection.unfilteredAll.winRateLower > 0.4, 'and a win rate that survives its confidence interval');
});

test('harness: replay forwards simulator options rather than ignoring them', { timeout: 60000 }, () => {
  const { ltf, htf } = randomWalkSeries({ bars: 2000, seed: 41 });
  const patient = replayInstrument({
    instrument: INSTRUMENT,
    htf,
    ltf,
    opts: { ...REPLAY_OPTS, simulator: { maxBars: 96 } },
  });
  const impatient = replayInstrument({
    instrument: INSTRUMENT,
    htf,
    ltf,
    opts: { ...REPLAY_OPTS, simulator: { maxBars: 2 } },
  });

  assert.equal(patient.trades.length, impatient.trades.length, 'the same setups are found either way');
  const timeouts = (run) => run.trades.filter((t) => t.status === 'timeout').length;
  assert.ok(
    timeouts(impatient) > timeouts(patient),
    'a two-bar limit must strand trades that a 96-bar limit resolves'
  );
  assert.ok(impatient.trades.every((t) => t.barsHeld <= 2));
});
