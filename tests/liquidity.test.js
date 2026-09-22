'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { findEqualLevels, detectSweeps, nextLiquidityPool, equalTolerance } = require('../src/liquidity');
const { detectSwings } = require('../src/structure/swings');
const { c, noise, BASE_TIME } = require('./helpers/candles');

const TF = 1800;
const at = (i) => BASE_TIME + i * TF;

const swingLow = (index, price) => ({ type: 'low', index, price, time: at(index), confirmedAt: index + 1 });
const swingHigh = (index, price) => ({ type: 'high', index, price, time: at(index), confirmedAt: index + 1 });

test('equal levels: lows within tolerance cluster, stops rest below the lowest', () => {
  const swings = [swingLow(2, 100.0), swingLow(6, 100.05), swingLow(10, 95.0)];
  const groups = findEqualLevels(swings, 'low', 0.1);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].type, 'EQL');
  assert.equal(groups[0].count, 2);
  assert.equal(groups[0].price, 100.0, 'the level is the lowest of the equal lows');
});

test('equal levels: highs cluster at the highest of the group', () => {
  const swings = [swingHigh(2, 110.0), swingHigh(6, 109.95), swingHigh(9, 110.02)];
  const groups = findEqualLevels(swings, 'high', 0.1);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].type, 'EQH');
  assert.equal(groups[0].count, 3);
  assert.equal(groups[0].price, 110.02);
});

test('equal levels: levels further apart than tolerance do not cluster', () => {
  const swings = [swingLow(2, 100), swingLow(6, 101)];
  assert.deepEqual(findEqualLevels(swings, 'low', 0.1), []);
  assert.equal(findEqualLevels(swings, 'low', 1.5).length, 1);
});

test('equal tolerance: derived from average range unless given explicitly', () => {
  const candles = noise(20, 100); // average range 1.0
  assert.ok(Math.abs(equalTolerance(candles, { equalLevelAtrFactor: 0.1 }) - 0.1) < 1e-9);
  assert.equal(equalTolerance(candles, { tolerance: 0.42 }), 0.42);
});

test('sweep: a wick through a prior swing low that closes back inside is a sweep', () => {
  const candles = [
    ...noise(10, 100),
    c(at(10), 100, 100.5, 98.0, 100.0), // swing low at 98
    c(at(11), 100, 100.6, 99.5, 100.4),
    c(at(12), 100.4, 100.8, 99.6, 100.5),
    c(at(13), 100.5, 100.6, 97.0, 100.3), // spikes to 97, closes back at 100.3
  ];
  const swings = detectSwings(candles, 1);
  const sweeps = detectSweeps(candles, swings, { breakIndex: 13, direction: 'bullish', sweepLookback: 12 });

  assert.equal(sweeps.length, 1);
  assert.equal(sweeps[0].type, 'wick');
  assert.equal(sweeps[0].index, 13);
  assert.equal(sweeps[0].level, 98);
  assert.equal(sweeps[0].depth, 1);
  assert.match(sweeps[0].reason, /stop hunt below the prior swing/);
});

test('sweep: a candle that closes BEYOND the level is a break, not a sweep', () => {
  const candles = [
    ...noise(10, 100),
    c(at(10), 100, 100.5, 98.0, 100.0), // swing low 98
    c(at(11), 100, 100.6, 99.5, 100.4),
    c(at(12), 100.4, 100.8, 99.6, 100.5),
    c(at(13), 100.5, 100.6, 97.0, 97.2), // closes below 98
  ];
  const swings = detectSwings(candles, 1);
  assert.deepEqual(detectSweeps(candles, swings, { breakIndex: 13, direction: 'bullish' }), []);
});

test('sweep: equal lows taken out are reported as an EQL sweep with the count', () => {
  const candles = [
    ...noise(8, 100),
    c(at(8), 100, 100.5, 98.0, 100.2), // swing low 98.00
    c(at(9), 100.2, 100.8, 99.8, 100.5),
    c(at(10), 100.5, 100.9, 98.02, 100.4), // swing low 98.02 -> equal lows
    c(at(11), 100.4, 100.9, 99.9, 100.6),
    c(at(12), 100.6, 100.7, 97.2, 100.5), // sweeps both
  ];
  const swings = detectSwings(candles, 1);
  const sweeps = detectSweeps(candles, swings, {
    breakIndex: 12,
    direction: 'bullish',
    tolerance: 0.1,
    sweepLookback: 12,
  });

  assert.equal(sweeps[0].type, 'EQL');
  assert.equal(sweeps[0].equalCount, 2);
  assert.equal(sweeps[0].level, 98.0, 'stops rest below the lower of the two');
  assert.match(sweeps[0].reason, /equal lows \(2\) at .* taken out before the reversal/);
});

test('sweep: buy-side sweeps for shorts mirror the logic', () => {
  const candles = [
    ...noise(10, 100),
    c(at(10), 100, 103.0, 99.8, 100.2), // swing high 103
    c(at(11), 100.2, 100.6, 99.6, 100.0),
    c(at(12), 100.0, 100.5, 99.5, 100.1),
    c(at(13), 100.1, 104.0, 100.0, 100.3), // wick above 103, closes back down
  ];
  const swings = detectSwings(candles, 1);
  const sweeps = detectSweeps(candles, swings, { breakIndex: 13, direction: 'bearish', sweepLookback: 12 });
  assert.equal(sweeps.length, 1);
  assert.equal(sweeps[0].level, 103);
  assert.equal(sweeps[0].direction, 'bearish');
  assert.match(sweeps[0].reason, /stop hunt above the prior swing/);
});

test('sweep: the lookback window bounds how far back a sweep counts', () => {
  const candles = [
    ...noise(10, 100),
    c(at(10), 100, 100.5, 98.0, 100.0),
    c(at(11), 100, 100.6, 99.5, 100.4),
    c(at(12), 100.4, 100.8, 99.6, 100.5),
    c(at(13), 100.5, 100.6, 97.0, 100.3), // the sweep
    c(at(14), 100.3, 101.0, 100.2, 100.9),
    c(at(15), 100.9, 101.5, 100.8, 101.4),
    c(at(16), 101.4, 102.0, 101.3, 101.9),
  ];
  const swings = detectSwings(candles, 1);
  assert.equal(detectSweeps(candles, swings, { breakIndex: 16, direction: 'bullish', sweepLookback: 12 }).length, 1);
  assert.equal(detectSweeps(candles, swings, { breakIndex: 16, direction: 'bullish', sweepLookback: 2 }).length, 0);
});

test('sweep: a swing not yet confirmed at the sweep candle is ignored (no look-ahead)', () => {
  const candles = [
    ...noise(10, 100),
    c(at(10), 100, 100.6, 99.5, 100.4),
    c(at(11), 100.4, 100.8, 97.0, 100.5), // dips before any swing below exists
    c(at(12), 100.5, 100.9, 99.6, 100.7),
    c(at(13), 100.7, 101.0, 96.0, 100.8), // swing low forms here
  ];
  const swings = detectSwings(candles, 1);
  const sweeps = detectSweeps(candles, swings, { breakIndex: 11, direction: 'bullish', sweepLookback: 12 });
  assert.equal(sweeps.length, 0, 'the swing at 11 cannot be swept by candle 11 itself');
});

test('sweep: a long body with a short wick is not a rejection', () => {
  const candles = [
    ...noise(10, 100),
    c(at(10), 100, 100.5, 98.0, 100.0), // swing low 98
    c(at(11), 100, 100.6, 99.5, 100.4),
    c(at(12), 100.4, 100.8, 99.6, 100.5),
    c(at(13), 98.2, 103.0, 97.9, 102.8), // body 4.6, lower wick 0.3
  ];
  const swings = detectSwings(candles, 1);
  assert.equal(detectSweeps(candles, swings, { breakIndex: 13, direction: 'bullish', minWickBodyRatio: 1 }).length, 0);
  assert.equal(detectSweeps(candles, swings, { breakIndex: 13, direction: 'bullish', minWickBodyRatio: 0 }).length, 1);
});

test('liquidity pools: the next pool beyond price prefers equal-level clusters', () => {
  const swings = [swingHigh(1, 105), swingHigh(4, 110), swingHigh(8, 110.05), swingHigh(12, 101)];
  const pool = nextLiquidityPool(swings, 100, 'bullish', { tolerance: 0.1 });
  assert.equal(pool.kind, 'EQH');
  assert.equal(pool.price, 110.05);
  assert.equal(pool.count, 2);

  const single = nextLiquidityPool([swingHigh(1, 105), swingHigh(4, 120)], 100, 'bullish', { tolerance: 0.1 });
  assert.equal(single.kind, 'swing');
  assert.equal(single.price, 105, 'closest untapped swing');

  assert.equal(nextLiquidityPool([swingHigh(1, 90)], 100, 'bullish'), null, 'nothing above price');
  assert.equal(nextLiquidityPool([swingLow(1, 90)], 100, 'bearish').price, 90);
});

test('liquidity pools: levels price has already traded through are not pools', () => {
  const candles = [
    ...noise(10, 100),
    c(at(10), 100, 103.0, 99.5, 102.5), // swing high 103
    c(at(11), 102.5, 102.8, 101.0, 101.5),
    c(at(12), 101.5, 108.0, 101.4, 107.5), // runs straight through 103
    c(at(13), 107.5, 108.2, 106.0, 106.5), // swing high 108.2, untapped
    c(at(14), 106.5, 106.8, 104.0, 104.2),
  ];
  const swings = detectSwings(candles, 1);

  const naive = nextLiquidityPool(swings, 104, 'bullish');
  assert.equal(naive.price, 108.2, 'the 103 high is below the entry price anyway');

  // From below the tapped level, it must still be skipped.
  const filtered = nextLiquidityPool(swings, 102, 'bullish', { candles });
  assert.equal(filtered.price, 108.2, 'the 103 high was already taken, so no stops rest there');

  const unfiltered = nextLiquidityPool(swings, 102, 'bullish');
  assert.equal(unfiltered.price, 103, 'without candles the check cannot be made');
});
