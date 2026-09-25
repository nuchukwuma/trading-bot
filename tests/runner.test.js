'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { BacktestRunner, replayOffThread } = require('../src/backtest/runner');
const { LearningService } = require('../src/learn');
const { randomWalkSeries } = require('../src/backtest/randomWalk');
const { buildReport, label } = require('../src/backtest/insights');

const SYN = {
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

function memoryDb() {
  const settings = new Map();
  let backtest = [];
  return {
    settings,
    get backtest() {
      return backtest;
    },
    isConnected: () => true,
    getSetting: async (k) => settings.get(k),
    setSetting: async (k, v) => settings.set(k, JSON.parse(JSON.stringify(v))),
    replaceBacktestTrades: async (trades) => {
      backtest = trades.map((t) => ({ ...t }));
      return trades.length;
    },
    loadBacktestTrades: async () => backtest,
    resolvedAlerts: async () => [],
    pendingAlerts: async () => [],
  };
}

test('runner: replay in a worker thread gives the same trades as the main thread', async () => {
  const { replayInstrument } = require('../src/backtest/replay');
  const { ltf, htf } = randomWalkSeries({ bars: 1500, seed: 5 });
  const data = { instrument: SYN, htf, ltf, opts: {} };
  const off = await replayOffThread(data);
  const on = replayInstrument(data);
  assert.equal(off.trades.length, on.trades.length);
  assert.deepEqual(off.trades.map((t) => t.rMultiple), on.trades.map((t) => t.rMultiple));
});

test('runner: a run stores every trade and the profile in the database, then reports', { timeout: 120000 }, async () => {
  const db = memoryDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-'));
  const learning = new LearningService({
    db,
    profilePath: path.join(dir, 'p.json'),
    seedPath: path.join(dir, 'seed.json'),
  });
  const series = randomWalkSeries({ bars: 3000, seed: 8 });
  const sent = [];
  let profileSeen = null;
  const runner = new BacktestRunner({
    data: { getHistory: async () => series },
    db,
    learning,
    instruments: [SYN],
    notify: async (t) => sent.push(t),
    onProfile: (p) => {
      profileSeen = p;
    },
  });

  assert.equal(await runner.run({ days: 60 }), true);
  assert.ok(db.backtest.length > 20, 'trades stored');
  assert.ok(db.backtest.every((t) => t.variants && Object.keys(t.variants).length === 12), 'with placement results');
  assert.ok(db.settings.get('edgeProfile'), 'profile stored in the database');
  assert.ok(profileSeen && profileSeen.loaded, 'the scanner is handed the new profile');
  assert.equal(db.settings.get('backtestRun').trades, db.backtest.length);
  assert.match(sent[0], /Backtest started/);
  assert.match(sent.at(-1), /Backtest — last 60 days[\s\S]*What worked/);
  assert.equal(await runner.report(), sent.at(-1));

  // A restart: a fresh service loads the same profile from the database, no file needed.
  fs.rmSync(dir, { recursive: true, force: true });
  const again = new LearningService({ db, profilePath: path.join(dir, 'gone.json') });
  const profile = await again.loadProfile();
  assert.equal(profile.loaded, true);
  assert.deepEqual(profile.rules, db.settings.get('edgeProfile').rules);
  const ledger = await again.loadLedger();
  assert.equal(ledger.length, db.backtest.length, 'the backtest ledger survives the restart too');
});

test('runner: a second run while one is going is refused', async () => {
  const runner = new BacktestRunner({ data: {}, db: memoryDb(), learning: {}, instruments: [] });
  runner.running = true;
  assert.equal(await runner.run(), false);
});

test('insights: labels read as plain English, combinations joined', () => {
  assert.equal(label('session:london & sweep:eql'), 'London session + EQL sweep');
  assert.equal(label('prev_day:took_low'), "took yesterday's low");
  assert.equal(label('unknown:thing'), 'unknown:thing');
});

test('insights: proven conditions are kept apart from hunches', () => {
  const trades = Array.from({ length: 40 }, (_, i) => ({ instrumentId: 'EURUSD', filled: true, rMultiple: i % 2 ? 2 : -1 }));
  const stat = (e, n) => ({ n, expectancy: e });
  const text = buildReport({
    trades,
    days: 365,
    coverage: [{ id: 'EURUSD', days: 365 }],
    result: {
      rules: { minScore: 4, requiredFeatures: ['session:london'], excludedFeatures: [], disabledInstruments: [] },
      validated: true,
      test: { expectancy: 0.4 },
      unfilteredTest: { expectancy: 0.1 },
      plan: { byGroup: {} },
      candidates: [
        { feature: 'session:london', significant: true, diff: 0.5, p: 0.001, with: stat(0.6, 80), without: stat(0.1, 200) },
        { feature: 'dow:fri', significant: true, diff: -0.4, p: 0.01, with: stat(-0.3, 50), without: stat(0.3, 230) },
        { feature: 'vol:high', significant: false, diff: 0.3, p: 0.1, with: stat(0.4, 60), without: stat(0.2, 220) },
      ],
    },
  });
  assert.match(text, /What worked[\s\S]*✅ London session: \+0\.60R on 80/);
  assert.match(text, /What to avoid[\s\S]*⛔ Fri/);
  assert.match(text, /Promising, not proven yet[\s\S]*high volatility/);
  assert.match(text, /needs London session/);
  assert.match(text, /now applied/);
});
