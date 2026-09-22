'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { simulateTrade } = require('../src/backtest/simulator');

const LONG = {
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

const SHORT = {
  direction: 'bearish',
  entryPrice: 100,
  stopPrice: 110,
  riskDistance: 10,
  targets: [
    { name: 'TP1', price: 80, closePct: 50, moveStopToBreakeven: true },
    { name: 'TP2', price: 65, closePct: 30, trailToStructure: true },
    { name: 'TP3', price: 50, closePct: 20 },
  ],
};

let t = 0;
const bar = (high, low, close = (high + low) / 2) => ({ time: (t += 1800), open: close, high, low, close });

test('simulator: the full ladder pays 0.5x2R + 0.3x3.5R + 0.2x5R = 3.05R', () => {
  const out = simulateTrade({
    plan: LONG,
    signalClose: 100,
    candles: [bar(121, 99), bar(136, 119), bar(151, 134)],
  });
  assert.equal(out.status, 'tp3');
  assert.equal(out.rMultiple, 3.05);
  assert.equal(out.remaining, 0);
  assert.deepEqual(out.exits.map((e) => e.reason), ['TP1', 'TP2', 'TP3']);
});

test('simulator: a clean stop loses exactly 1R', () => {
  const out = simulateTrade({ plan: LONG, signalClose: 100, candles: [bar(102, 89, 91)] });
  assert.equal(out.status, 'stopped');
  assert.equal(out.rMultiple, -1);
  assert.equal(out.exits[0].reason, 'stop');
});

test('simulator: stop and target in one candle resolves to the stop', () => {
  // This candle spans 89 to 121 — it contains both the stop and TP1.
  const candles = [bar(121, 89, 110)];

  const pessimistic = simulateTrade({ plan: LONG, signalClose: 100, candles });
  assert.equal(pessimistic.rMultiple, -1, 'the ambiguous candle must not be given the benefit of the doubt');
  assert.equal(pessimistic.status, 'stopped');

  const optimistic = simulateTrade({ plan: LONG, signalClose: 100, candles, opts: { pessimistic: false } });
  assert.ok(optimistic.rMultiple > 0, 'the optional optimistic mode flips it, which is why it is not the default');
});

test('simulator: a stop moved to breakeven only takes effect on the next candle', () => {
  // TP1 is hit on bar 0 and that same bar dips back to the entry. Treating the
  // new breakeven stop as live inside bar 0 would double-count one candle.
  const out = simulateTrade({
    plan: LONG,
    signalClose: 100,
    candles: [bar(121, 99.5, 105), bar(110, 99, 100)],
  });
  assert.equal(out.exits[0].reason, 'TP1');
  assert.equal(out.exits[1].reason, 'stop');
  assert.equal(out.exits[1].price, 100, 'the remainder exits at breakeven, not the original stop');
  assert.equal(out.rMultiple, 1, '0.5 x 2R + 0.5 x 0R');
  assert.equal(out.status, 'tp1');
});

test('simulator: one candle can clear more than one target', () => {
  const out = simulateTrade({
    plan: LONG,
    signalClose: 100,
    candles: [bar(136, 99, 135), bar(137, 134, 136)],
  });
  const [first, second] = out.exits;
  assert.equal(first.reason, 'TP1');
  assert.equal(second.reason, 'TP2');
  assert.equal(first.bar, 0);
  assert.equal(second.bar, 0, 'both cleared inside the same candle');
  assert.equal(out.status, 'tp2');
  // The 20% runner is still open when the data ends, so it is marked to market
  // rather than quietly dropped.
  assert.equal(out.exits[2].reason, 'timeout');
  assert.equal(out.remaining, 0);
});

test('simulator: shorts mirror longs exactly', () => {
  const win = simulateTrade({
    plan: SHORT,
    signalClose: 100,
    candles: [bar(101, 79, 80), bar(81, 64, 65), bar(66, 49, 50)],
  });
  assert.equal(win.status, 'tp3');
  assert.equal(win.rMultiple, 3.05);

  const loss = simulateTrade({ plan: SHORT, signalClose: 100, candles: [bar(111, 98, 109)] });
  assert.equal(loss.rMultiple, -1);
});

test('simulator: the runner trails behind structure after TP2', () => {
  const out = simulateTrade({
    plan: LONG,
    signalClose: 100,
    candles: [
      bar(121, 99, 120), // TP1
      bar(136, 119, 135), // TP2 -> trailing starts
      bar(140, 130, 138),
      bar(138, 125, 130), // swing low at 125
      bar(142, 133, 140), // confirms that swing -> stop trails up to 125
      bar(141, 120, 122), // drops through the trailed stop
    ],
    opts: { trailLookback: 1 },
  });
  const last = out.exits[out.exits.length - 1];
  assert.equal(last.reason, 'stop');
  assert.equal(last.price, 125, 'the stop trailed to the confirmed swing low');
  assert.ok(last.price > 100, 'well above breakeven');
  assert.ok(Math.abs(out.rMultiple - (0.5 * 2 + 0.3 * 3.5 + 0.2 * 2.5)) < 1e-9);
});

test('simulator: a trade that never resolves is marked to market, not dropped', () => {
  const flat = Array.from({ length: 5 }, () => bar(105, 98, 101));
  const out = simulateTrade({ plan: LONG, signalClose: 100, candles: flat, opts: { maxBars: 5 } });
  assert.equal(out.status, 'timeout');
  assert.equal(out.remaining, 0, 'the open remainder is closed at the last price');
  assert.ok(Math.abs(out.rMultiple - 0.1) < 1e-9, 'marked out at 101 = +0.1R');
});

test('simulator: maxBars caps how long a trade is held', () => {
  const slow = [...Array.from({ length: 10 }, () => bar(105, 98, 101)), bar(121, 99, 120)];
  const capped = simulateTrade({ plan: LONG, signalClose: 100, candles: slow, opts: { maxBars: 5 } });
  assert.equal(capped.status, 'timeout');
  assert.equal(capped.barsHeld, 5);

  const patient = simulateTrade({ plan: LONG, signalClose: 100, candles: slow, opts: { maxBars: 20 } });
  assert.equal(patient.status, 'tp1');
});

test('simulator: an unfilled limit entry expires instead of counting as a loss', () => {
  const limitPlan = { ...LONG, entryPrice: 95 };
  const awayFromEntry = Array.from({ length: 10 }, () => bar(108, 99, 105));

  const out = simulateTrade({
    plan: limitPlan,
    signalClose: 100,
    candles: awayFromEntry,
    opts: { maxBarsToFill: 4 },
  });
  assert.equal(out.filled, false);
  assert.equal(out.status, 'expired');
  assert.equal(out.rMultiple, 0);
  assert.deepEqual(out.exits, []);
});

test('simulator: a limit entry that fills is then traded normally', () => {
  const limitPlan = { ...LONG, entryPrice: 95, stopPrice: 85, targets: [{ name: 'TP1', price: 115, closePct: 100 }] };
  const out = simulateTrade({
    plan: limitPlan,
    signalClose: 100,
    candles: [bar(101, 94, 96), bar(116, 96, 115)],
    opts: { maxBarsToFill: 4 },
  });
  assert.equal(out.filled, true);
  assert.equal(out.fillBar, 0);
  assert.equal(out.status, 'tp1');
  assert.equal(out.rMultiple, 2);
});

test('simulator: excursions are recorded for analysis', () => {
  const out = simulateTrade({
    plan: LONG,
    signalClose: 100,
    candles: [bar(118, 95, 110), bar(121, 108, 120)],
  });
  assert.ok(Math.abs(out.mfe - 2.1) < 1e-9, 'best unrealised move was +2.1R');
  assert.ok(Math.abs(out.mae + 0.5) < 1e-9, 'worst was -0.5R');
});

test('simulator: an immediate gap through the stop still costs exactly the stop', () => {
  // A jump index can open far below the stop. The fill is modelled at the stop
  // level, so slippage beyond it is NOT captured — a known optimism.
  const out = simulateTrade({ plan: LONG, signalClose: 100, candles: [bar(88, 70, 75)] });
  assert.equal(out.rMultiple, -1);
  assert.equal(out.exits[0].price, 90);
});
