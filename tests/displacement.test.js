'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isDisplacementCandle, findDisplacement, describeDisplacement } = require('../src/structure/displacement');
const { dealingRange, zoneOf, positionInRange, isFavourableZone, describeZone } = require('../src/structure/range');
const { c, noise, BASE_TIME } = require('./helpers/candles');

const TF = 1800;
const at = (i) => BASE_TIME + i * TF;

test('displacement: a body 1.5x the average range qualifies, a smaller one does not', () => {
  const base = noise(20, 100); // average range 1.0
  const big = [...base, c(at(20), 100, 101.7, 99.9, 101.6)]; // body 1.6
  const small = [...base, c(at(20), 100, 101.4, 99.9, 101.3)]; // body 1.3

  const d = isDisplacementCandle(big, 20, { avgPeriod: 20, bodyMultiple: 1.5 });
  assert.ok(d);
  assert.equal(d.direction, 'bullish');
  assert.ok(Math.abs(d.averageRange - 1) < 1e-9);
  assert.ok(Math.abs(d.ratio - 1.6) < 1e-9);

  assert.equal(isDisplacementCandle(small, 20, { avgPeriod: 20, bodyMultiple: 1.5 }), null);
});

test('displacement: the candle under test does not inflate its own average', () => {
  const base = noise(20, 100);
  const huge = [...base, c(at(20), 100, 110, 99, 109)]; // range 11, body 9
  const d = isDisplacementCandle(huge, 20, { avgPeriod: 20, bodyMultiple: 1.5 });
  assert.ok(Math.abs(d.averageRange - 1) < 1e-9, 'average excludes the tested candle');
  assert.ok(d.ratio > 8);
});

test('displacement: direction is taken from the body', () => {
  const base = noise(20, 100);
  const down = [...base, c(at(20), 101.6, 101.7, 99.9, 100.0)];
  assert.equal(isDisplacementCandle(down, 20, { bodyMultiple: 1.5 }).direction, 'bearish');
});

test('displacement: findDisplacement scans a window and returns the strongest match', () => {
  const candles = [
    ...noise(20, 100),
    c(at(20), 100, 101.8, 99.9, 101.7), // ratio ~1.7
    c(at(21), 101.7, 105.0, 101.6, 104.8), // ratio ~3.1 (strongest)
    c(at(22), 104.8, 105.0, 104.5, 104.9), // small
  ];
  const best = findDisplacement(candles, 22, 'bullish', { lookback: 5, bodyMultiple: 1.5 });
  assert.equal(best.index, 21);

  assert.equal(findDisplacement(candles, 22, 'bearish', { lookback: 5, bodyMultiple: 1.5 }), null);
  assert.equal(findDisplacement(candles, 22, 'bullish', { lookback: 1, bodyMultiple: 1.5 }), null, 'window excludes it');
  assert.match(describeDisplacement(best), /Displacement candle drove the move/);
  assert.match(describeDisplacement(null), /no displacement candle/);
});

test('displacement: returns null when there is no history to average', () => {
  assert.equal(isDisplacementCandle([c(at(0), 1, 2, 0, 1.9)], 0), null);
  assert.equal(isDisplacementCandle([], 0), null);
});

test('range: equilibrium splits the leg and premium/discount follow from it', () => {
  const r = dealingRange([], { leg: { low: 100, high: 200 } });
  assert.equal(r.equilibrium, 150);
  assert.equal(r.size, 100);
  assert.equal(zoneOf(120, r), 'discount');
  assert.equal(zoneOf(180, r), 'premium');
  assert.equal(zoneOf(150, r), 'equilibrium');
  assert.equal(positionInRange(125, r), 0.25);
});

test('range: longs need discount, shorts need premium', () => {
  const r = dealingRange([], { leg: { low: 100, high: 200 } });
  assert.equal(isFavourableZone(120, r, 'bullish'), true);
  assert.equal(isFavourableZone(180, r, 'bullish'), false);
  assert.equal(isFavourableZone(180, r, 'bearish'), true);
  assert.equal(isFavourableZone(120, r, 'bearish'), false);
  assert.equal(isFavourableZone(150, r, 'bullish'), false, 'exact equilibrium is not a discount');
  assert.match(describeZone(120, r, 'bullish'), /discount at 20% of the dealing range/);
});

test('range: optimal trade entry band is the 62-79% retracement', () => {
  const r = dealingRange([], { leg: { low: 0, high: 100 } });
  assert.deepEqual(r.oteLong, { from: 21, to: 38 });
  assert.deepEqual(r.oteShort, { from: 62, to: 79 });
});

test('range: falls back to a candle window when no leg is supplied', () => {
  const candles = [
    ...noise(10, 100),
    c(at(10), 100, 120, 100, 119),
    c(at(11), 119, 121, 90, 95),
  ];
  const r = dealingRange(candles, { rangeLookback: 60 });
  assert.equal(r.high, 121);
  assert.equal(r.low, 90);
  assert.equal(r.equilibrium, 105.5);

  assert.equal(dealingRange([], {}), null);
  assert.equal(dealingRange([c(at(0), 5, 5, 5, 5)], {}), null, 'a zero-width range is not usable');
  assert.equal(zoneOf(1, null), 'unknown');
  assert.equal(positionInRange(1, null), null);
});
