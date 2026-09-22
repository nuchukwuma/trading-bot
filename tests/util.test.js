'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  averageRange,
  averageBody,
  highestHigh,
  lowestLow,
  normalize,
  mergeSeries,
  upperWick,
  lowerWick,
  isCandle,
  assertCandles,
} = require('../src/util/candles');
const { roundToStep, overlap, overlaps, round, decimalsOf } = require('../src/util/math');
const { bucketStart, nextBoundary, msUntilNextBoundary, formatUtc } = require('../src/util/time');
const { series, c } = require('./helpers/candles');

test('candles: wick and body helpers', () => {
  const bull = c(0, 10, 13, 9, 12);
  assert.equal(upperWick(bull), 1);
  assert.equal(lowerWick(bull), 1);
  const bear = c(0, 12, 12.5, 8, 9);
  assert.equal(upperWick(bear), 0.5);
  assert.equal(lowerWick(bear), 1);
});

test('candles: averageRange and averageBody honour the period window', () => {
  const s = series([
    [10, 12, 8, 11], // range 4, body 1
    [11, 15, 11, 14], // range 4, body 3
    [14, 20, 10, 15], // range 10, body 1
  ]);
  assert.equal(averageRange(s, 3), (4 + 4 + 10) / 3);
  assert.equal(averageRange(s, 2), (4 + 10) / 2);
  assert.equal(averageBody(s, 3), (1 + 3 + 1) / 3);
  // ending earlier in the series
  assert.equal(averageRange(s, 2, 1), 4);
});

test('candles: highestHigh / lowestLow report price and index', () => {
  const s = series([
    [10, 12, 8, 11],
    [11, 18, 10, 14],
    [14, 16, 5, 15],
  ]);
  assert.deepEqual(highestHigh(s), { price: 18, index: 1 });
  assert.deepEqual(lowestLow(s), { price: 5, index: 2 });
  assert.deepEqual(highestHigh(s, 0, 0), { price: 12, index: 0 });
});

test('candles: normalize sorts, dedupes by time and keeps the later revision', () => {
  const a = c(200, 1, 2, 0.5, 1.5);
  const b = c(100, 1, 2, 0.5, 1.5);
  const bRevised = c(100, 1, 9, 0.5, 8);
  const out = normalize([a, b, bRevised]);
  assert.equal(out.length, 2);
  assert.equal(out[0].time, 100);
  assert.equal(out[0].high, 9, 'later revision of the same timestamp wins');
  assert.equal(out[1].time, 200);
});

test('candles: mergeSeries caps length keeping the newest', () => {
  const existing = series([[1, 2, 0, 1]], { start: 100, tf: 100 });
  const incoming = series(
    [
      [2, 3, 1, 2],
      [3, 4, 2, 3],
    ],
    { start: 200, tf: 100 }
  );
  const merged = mergeSeries(existing, incoming, 2);
  assert.equal(merged.length, 2);
  assert.deepEqual(
    merged.map((x) => x.time),
    [200, 300]
  );
});

test('candles: validation rejects malformed candles', () => {
  assert.equal(isCandle({ time: 1, open: 1, high: 2, low: 0, close: 1 }), true);
  assert.equal(isCandle({ time: 1, open: 1, high: 2, low: 0 }), false);
  assert.throws(() => assertCandles([{ time: 1 }]), /not a valid candle/);
});

test('math: roundToStep floors by default so size never over-risks', () => {
  assert.equal(roundToStep(0.0567, 0.01), 0.05);
  assert.equal(roundToStep(0.0567, 0.01, 'ceil'), 0.06);
  assert.equal(roundToStep(0.06999999999, 0.001), 0.069);
  assert.equal(roundToStep(1.23, 0), 1.23, 'step of 0 is a no-op');
  assert.equal(decimalsOf(0.001), 3);
});

test('math: overlap measures shared span, overlaps allows touching edges', () => {
  assert.equal(overlap(1, 5, 4, 8), 1);
  assert.equal(overlap(1, 5, 6, 8), 0);
  assert.equal(overlaps(1, 5, 5, 8), true, 'touching counts as overlapping');
  assert.equal(overlaps(1, 5, 5.0001, 8), false);
  assert.equal(round(-0.0000001, 5), 0, 'never returns -0');
});

test('time: bucketing and boundary maths', () => {
  const tf = 1800;
  assert.equal(bucketStart(1700000000, tf), 1699999200);
  assert.equal(nextBoundary(1699999200, tf), 1700001000);
  // 10 minutes past a 30m boundary -> 20 minutes to the next, +15s settle delay
  const now = 1699999200 * 1000 + 10 * 60 * 1000;
  assert.equal(msUntilNextBoundary(tf, 15, now), 20 * 60 * 1000 + 15000);
  assert.match(formatUtc(1700000000), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
});
