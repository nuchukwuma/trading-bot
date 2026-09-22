'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { detectSwings, lastSwing, swingsKnownAt, swingHighs, swingLows } = require('../src/structure/swings');
const { analyzeStructure, lastEventInDirection, describeEvent } = require('../src/structure/marketStructure');
const { series } = require('./helpers/candles');

// A hand-built series: neutral -> bullish BOS -> bearish CHoCH.
// index: [open, high, low, close]
const TREND_SERIES = series([
  [100, 102, 99, 101], // 0
  [101, 105, 100, 104], // 1  swing high @105
  [104, 103, 97, 99], // 2
  [99, 102, 95, 101], // 3  swing low @95
  [101, 104, 98, 103], // 4
  [103, 107, 103, 106], // 5  closes 106 > 105 -> BOS bullish
  [106, 108, 105, 107], // 6  swing high @108
  [107, 107, 102, 103], // 7
  [103, 104, 100, 101], // 8  swing low @100
  [101, 103, 101, 102], // 9
  [102, 102, 98, 99], // 10 closes 99 < 100 -> CHoCH bearish
]);

test('swings: fractal detection finds highs and lows with lookback 1', () => {
  const swings = detectSwings(TREND_SERIES, 1);
  const highs = swingHighs(swings).map((s) => s.index);
  const lows = swingLows(swings).map((s) => s.index);
  assert.deepEqual(highs, [1, 6]);
  assert.deepEqual(lows, [3, 8]);

  const h1 = swings.find((s) => s.index === 1 && s.type === 'high');
  assert.equal(h1.price, 105);
  assert.equal(h1.confirmedAt, 2, 'a swing is only known one candle (lookback) later');
});

test('swings: lookback 2 requires two lower highs each side', () => {
  const s = series([
    [10, 11, 9, 10],
    [10, 12, 9, 11],
    [11, 20, 10, 19], // clear swing high
    [19, 13, 12, 12],
    [12, 12, 8, 9],
  ]);
  assert.deepEqual(
    detectSwings(s, 2).filter((x) => x.type === 'high').map((x) => x.index),
    [2]
  );
  // With a series too short for the window nothing is returned.
  assert.deepEqual(detectSwings(s.slice(0, 4), 2), []);
});

test('swings: equal highs form no fractal (they are liquidity, not structure)', () => {
  const s = series([
    [10, 11, 9, 10],
    [10, 15, 10, 14],
    [14, 13, 12, 12],
    [12, 15, 11, 14], // exactly equal to the earlier high
    [14, 13, 10, 11],
  ]);
  const highs = detectSwings(s, 1).filter((x) => x.type === 'high');
  assert.deepEqual(highs.map((h) => h.index), [1, 3], 'both are fractals against their own neighbours');

  // But a plateau of identical highs yields none between them.
  const plateau = series([
    [10, 11, 9, 10],
    [10, 15, 10, 14],
    [14, 15, 12, 14],
    [14, 15, 11, 12],
    [12, 11, 10, 10],
  ]);
  assert.deepEqual(detectSwings(plateau, 1).filter((x) => x.type === 'high'), []);
});

test('swings: swingsKnownAt and lastSwing respect confirmation lag', () => {
  const swings = detectSwings(TREND_SERIES, 1);
  assert.equal(swingsKnownAt(swings, 1).length, 0, 'nothing is confirmed at index 1');
  assert.equal(swingsKnownAt(swings, 2).length, 1);
  assert.equal(lastSwing(swings, 'high', 2).index, 1);
  assert.equal(lastSwing(swings, 'high', 5).index, 1, 'the @108 high is not yet confirmed at index 5');
  assert.equal(lastSwing(swings, 'high', 7).index, 6);
  assert.equal(lastSwing(swings, 'low', 0), null);
});

test('structure: first break from neutral is a BOS, counter-trend break is a CHoCH', () => {
  const st = analyzeStructure(TREND_SERIES, { swingLookback: 1, breakOnClose: true });

  assert.equal(st.events.length, 2);

  const [bos, choch] = st.events;
  assert.equal(bos.type, 'BOS');
  assert.equal(bos.direction, 'bullish');
  assert.equal(bos.index, 5);
  assert.equal(bos.previousTrend, 'neutral');
  assert.equal(bos.brokenSwing.price, 105);

  assert.equal(choch.type, 'CHoCH');
  assert.equal(choch.direction, 'bearish');
  assert.equal(choch.index, 10);
  assert.equal(choch.previousTrend, 'bullish');
  assert.equal(choch.brokenSwing.price, 100);

  assert.equal(st.trend, 'bearish');
  assert.equal(st.lastEvent, choch);
});

test('structure: a continuation break in the same direction is a BOS, not a CHoCH', () => {
  const s = series([
    [100, 102, 99, 101], // 0
    [101, 105, 100, 104], // 1 swing high 105
    [104, 103, 97, 99], // 2
    [99, 102, 95, 101], // 3 swing low 95
    [101, 104, 98, 103], // 4
    [103, 107, 103, 106], // 5 BOS bullish (105 broken)
    [106, 110, 105, 109], // 6 swing high 110
    [109, 109, 106, 107], // 7
    [107, 112, 106, 111], // 8 BOS bullish again (110 broken)
  ]);
  const st = analyzeStructure(s, { swingLookback: 1, breakOnClose: true });
  assert.deepEqual(st.events.map((e) => `${e.direction}:${e.type}`), ['bullish:BOS', 'bullish:BOS']);
  assert.equal(st.trend, 'bullish');
});

test('structure: a wick through the level is not a break when breakOnClose is set', () => {
  const s = series([
    [100, 102, 99, 101],
    [101, 105, 100, 104], // swing high 105
    [104, 103, 97, 99],
    [99, 102, 95, 101], // swing low 95
    [101, 104, 98, 103],
    [103, 108, 103, 104.5], // wick to 108 but closes back under 105
  ]);
  const closeBased = analyzeStructure(s, { swingLookback: 1, breakOnClose: true });
  assert.equal(closeBased.events.length, 0, 'wick alone does not break structure');

  const wickBased = analyzeStructure(s, { swingLookback: 1, breakOnClose: false });
  assert.equal(wickBased.events.length, 1, 'wick-based mode does treat it as a break');
  assert.equal(wickBased.events[0].direction, 'bullish');
});

test('structure: a broken level is never re-used as a reference', () => {
  const s = series([
    [100, 102, 99, 101],
    [101, 105, 100, 104], // swing high 105
    [104, 103, 97, 99],
    [99, 102, 95, 101], // swing low 95
    [101, 104, 98, 103],
    [103, 107, 103, 106], // BOS over 105
    [106, 107, 104, 106.5], // still above 105 — must not fire again
    [106.5, 107, 104, 106.2],
  ]);
  const st = analyzeStructure(s, { swingLookback: 1, breakOnClose: true });
  assert.equal(st.events.length, 1, 'the same swing high only breaks once');
});

test('structure: no event is emitted before its swing was confirmed (no look-ahead)', () => {
  const st = analyzeStructure(TREND_SERIES, { swingLookback: 1, breakOnClose: true });
  for (const e of st.events) {
    const swing = st.swings.find((x) => x.index === e.brokenSwing.index && x.type === e.brokenSwing.type);
    assert.ok(swing.confirmedAt <= e.index, `event at ${e.index} used a swing confirmed at ${swing.confirmedAt}`);
  }
});

test('structure: a swing high survives a bearish break and can still be broken later', () => {
  const s = series([
    [100, 102, 99, 101], // 0
    [101, 110, 100, 109], // 1 swing high 110
    [109, 108, 104, 105], // 2
    [105, 107, 100, 106], // 3 swing low 100
    [106, 108, 104, 107], // 4
    [107, 108, 98, 99], // 5 closes below 100 -> bearish BOS
    [99, 101, 96, 97], // 6
    [97, 103, 96, 102], // 7 swing low 96 (confirmed at 8)
    [102, 112, 101, 111], // 8 closes above the OLD 110 high -> bullish CHoCH
  ]);
  const st = analyzeStructure(s, { swingLookback: 1, breakOnClose: true });
  const kinds = st.events.map((e) => `${e.direction}:${e.type}`);
  assert.deepEqual(kinds, ['bearish:BOS', 'bullish:CHoCH']);
  assert.equal(st.events[1].brokenSwing.price, 110, 'the pre-existing high stayed a valid reference');
});

test('structure: events carry the impulse leg range for premium/discount use', () => {
  const st = analyzeStructure(TREND_SERIES, { swingLookback: 1, breakOnClose: true });
  const bos = st.events[0];
  assert.equal(bos.leg.low, 95, 'leg low is the origin of the impulse');
  assert.equal(bos.leg.high, 107, 'leg high is the extreme reached at the break');
  assert.ok(bos.leg.lowIndex < bos.leg.highIndex);
});

test('structure: helpers for direction lookup and description', () => {
  const st = analyzeStructure(TREND_SERIES, { swingLookback: 1, breakOnClose: true });
  assert.equal(lastEventInDirection(st, 'bullish').index, 5);
  assert.equal(lastEventInDirection(st, 'bearish').index, 10);
  assert.match(describeEvent(st.lastEvent), /Change of character to the downside/);
  assert.match(describeEvent(st.events[0]), /Break of structure to the upside/);
  assert.match(describeEvent(null), /no structural break/);
});

test('structure: empty and tiny series are handled without throwing', () => {
  assert.deepEqual(analyzeStructure([], { swingLookback: 2 }).events, []);
  assert.equal(analyzeStructure(TREND_SERIES.slice(0, 2), { swingLookback: 2 }).trend, 'neutral');
});
