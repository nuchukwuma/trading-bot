'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolvePending } = require('../src/learn/outcomeTracker');
const { rateSetup, describeRating } = require('../src/learn/rater');
const { formatTradeEvent, formatOpenTrades, formatResults } = require('../src/alerts/tradeUpdates');

const T0 = 1700000000;
const bar = (i, high, low, close) => ({ time: T0 + i * 1800, open: close, high, low, close });

// A long whose limit entry (100) sits below the signal close (104).
const DOC = {
  _id: 'a1',
  instrumentId: 'EURUSD',
  side: 'BUY',
  direction: 'bullish',
  delivered: true,
  candleTime: new Date(T0 * 1000),
  price: 104,
  tradePlan: {
    entryPrice: 100,
    stopPrice: 90,
    riskDistance: 10,
    riskUsd: 3,
    targets: [
      { name: 'TP1', price: 120, closePct: 50, moveStopToBreakeven: true },
      { name: 'TP2', price: 135, closePct: 30, trailToStructure: true },
      { name: 'TP3', price: 150, closePct: 20 },
    ],
  },
};

function trackingDb(doc) {
  const state = { doc: { ...doc }, recorded: null };
  return {
    state,
    pendingAlerts: async () => (state.recorded ? [] : [state.doc]),
    updateProgress: async (id, progress) => {
      state.doc = { ...state.doc, progress };
    },
    recordOutcome: async (id, outcome) => {
      state.recorded = outcome;
    },
  };
}

async function step(db, candles, events) {
  return resolvePending({
    db,
    instrument: { id: 'EURUSD' },
    candles,
    opts: { maxBars: 96 },
    now: candles[candles.length - 1].time,
    onEvent: async (doc, e) => events.push(e),
  });
}

test('tracking: an unfilled limit entry is not expired before its 8-candle window', async () => {
  const db = trackingDb(DOC);
  const events = [];
  const r = await step(db, [bar(1, 106, 102, 105), bar(2, 107, 103, 106)], events);
  assert.equal(r.stillOpen, 1);
  assert.equal(db.state.recorded, null, 'still waiting for the entry');
  assert.equal(events.length, 0);
  assert.equal(db.state.doc.progress.filled, false);
});

test('tracking: a limit that never fills is invalidated after 8 candles', async () => {
  const db = trackingDb(DOC);
  const events = [];
  const candles = Array.from({ length: 8 }, (_, i) => bar(i + 1, 110, 102, 105));
  await step(db, candles, events);
  assert.equal(db.state.recorded.status, 'expired');
  assert.equal(events.at(-1).type, 'closed');
  assert.match(formatTradeEvent(DOC, events.at(-1)), /Invalidated/);
});

test('tracking: fill, TP1 while still running, then the final result — one message each', async () => {
  const db = trackingDb(DOC);
  const events = [];
  const candles = [bar(1, 105, 99, 101)];
  await step(db, candles, events); // entry fills
  assert.deepEqual(events.map((e) => e.type), ['filled']);

  candles.push(bar(2, 121, 101, 118));
  await step(db, candles, events); // TP1 pays, trade keeps running
  assert.deepEqual(events.map((e) => e.type), ['filled', 'target']);
  assert.equal(events[1].name, 'TP1');
  assert.equal(db.state.recorded, null, 'TP1 alone does not close the trade');
  assert.match(formatTradeEvent(DOC, events[1]), /TP1 hit[\s\S]*breakeven/);

  candles.push(bar(3, 119, 100, 101));
  await step(db, candles, events); // back to the breakeven stop
  assert.equal(events.at(-1).type, 'closed');
  assert.equal(db.state.recorded.status, 'tp1');
  const msg = formatTradeEvent(DOC, events.at(-1));
  assert.match(msg, /Win/);
  assert.match(msg, /\+1\.00R \(\+\$3\.00\)/);
});

test('tracking: a stop-out reports the loss in R and dollars', async () => {
  const db = trackingDb(DOC);
  const events = [];
  await step(db, [bar(1, 105, 99, 101), bar(2, 101, 89, 90)], events);
  assert.equal(db.state.recorded.status, 'stopped');
  assert.match(formatTradeEvent(DOC, events.at(-1)), /Stopped out[\s\S]*−1\.00R \(−\$3\.00\)/);
});

const trade = (i, r, extra = {}) => ({
  source: 'backtest',
  instrumentId: 'EURUSD',
  instrumentKind: 'forex',
  score: 4,
  filled: true,
  rMultiple: r,
  time: i,
  ...extra,
});

test('rater: not enough history reads as unknown, not as a verdict', () => {
  const r = rateSetup([trade(1, 2), trade(2, -1)], { instrumentId: 'EURUSD', score: 4 }, { minSamples: 30 });
  assert.equal(r.grade, 'unknown');
  assert.match(describeRating(r).join(' '), /2 similar trade\(s\).*30 needed/);
});

test('rater: a clearly profitable group is high, a clearly losing one low', () => {
  const good = Array.from({ length: 60 }, (_, i) => trade(i, i % 3 === 0 ? -1 : 2));
  assert.equal(rateSetup(good, { instrumentId: 'EURUSD', score: 4 }).grade, 'high');
  const bad = Array.from({ length: 60 }, (_, i) => trade(i, i % 5 === 0 ? 2 : -1));
  assert.equal(rateSetup(bad, { instrumentId: 'EURUSD', score: 4 }).grade, 'low');
  const coin = Array.from({ length: 40 }, (_, i) => trade(i, i % 2 ? 1 : -1));
  assert.equal(rateSetup(coin, { instrumentId: 'EURUSD', score: 4 }).grade, 'neutral');
});

test('rater: falls back from the pair to wider groups when the pair is thin', () => {
  const others = Array.from({ length: 40 }, (_, i) => trade(i, 2, { instrumentId: 'GBPUSD' }));
  const r = rateSetup(others, { instrumentId: 'EURUSD', instrumentKind: 'forex', score: 4 });
  assert.equal(r.cohort, 'forex pairs at 4/6');
  assert.equal(r.n, 40);
});

test('reports: /trades lists running and waiting trades, or says there are none', () => {
  assert.match(formatOpenTrades([], { shadowCount: 2 }), /No open trades[\s\S]*2 setup/);
  const running = { ...DOC, progress: { filled: true, targetsHit: ['TP1'], currentR: 1.4, lastPrice: 125 } };
  const waiting = { ...DOC, _id: 'a2', side: 'SELL', progress: { filled: false, barsSinceSignal: 3, lastPrice: 104 } };
  const text = formatOpenTrades([running, waiting]);
  assert.match(text, /1 running, 1 waiting/);
  assert.match(text, /\+1\.40R.*TP1 paid/);
  assert.match(text, /5 candle\(s\) left to fill/);
});

test('reports: /results totals wins and R, and counts invalidated separately', () => {
  const closed = [
    { ...DOC, outcome: { status: 'tp2', rMultiple: 2.5 } },
    { ...DOC, outcome: { status: 'stopped', rMultiple: -1 } },
    { ...DOC, outcome: { status: 'expired', rMultiple: 0 } },
  ];
  const text = formatResults(closed, { days: 7 });
  assert.match(text, /2 traded, 1 invalidated/);
  assert.match(text, /Won 1\/2 \(50%\) · total \+1\.50R \(\+\$4\.50\)/);
});
