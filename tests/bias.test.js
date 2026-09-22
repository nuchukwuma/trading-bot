'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeBias } = require('../src/structure/bias');
const { series } = require('./helpers/candles');

// Reuse the structure fixture: BOS bullish at 5, CHoCH bearish at 10.
const TREND_SERIES = series([
  [100, 102, 99, 101],
  [101, 105, 100, 104],
  [104, 103, 97, 99],
  [99, 102, 95, 101],
  [101, 104, 98, 103],
  [103, 107, 103, 106],
  [106, 108, 105, 107],
  [107, 107, 102, 103],
  [103, 104, 100, 101],
  [101, 103, 101, 102],
  [102, 102, 98, 99],
]);

const poi = (o) => ({
  kind: 'OB',
  mitigated: false,
  violated: false,
  index: 0,
  time: 0,
  ...o,
});

test('bias: direction follows 4H structure and a clean trend is moderate', () => {
  const b = computeBias(TREND_SERIES, {
    structureOpts: { swingLookback: 1, breakOnClose: true },
    pois: [],
    price: 99,
  });
  assert.equal(b.direction, 'bearish');
  assert.equal(b.score, 1);
  assert.equal(b.strength, 'moderate');
  assert.match(b.reasons[0], /4H bias is bearish/);
  assert.match(b.reasons[1], /No unmitigated 4H POI/);
});

test('bias: reacting to an aligned unmitigated POI strengthens it', () => {
  const b = computeBias(TREND_SERIES, {
    structureOpts: { swingLookback: 1, breakOnClose: true },
    pois: [poi({ direction: 'bearish', top: 100, bottom: 98 })],
    price: 99,
  });
  assert.equal(b.score, 2);
  assert.equal(b.strength, 'strong');
  assert.ok(b.activePoi);
  assert.match(b.reasons[1], /reacting to an unmitigated 4H order block/);
});

test('bias: approaching an aligned POI adds half a point', () => {
  const b = computeBias(TREND_SERIES, {
    structureOpts: { swingLookback: 1, breakOnClose: true },
    // Bearish supply above price; price rallying towards it.
    pois: [poi({ direction: 'bearish', top: 102, bottom: 101 })],
    price: 100.5,
    poi: { approachZoneMultiple: 1.5 },
  });
  assert.equal(b.score, 1.5);
  assert.equal(b.strength, 'moderate');
  assert.ok(b.approachingPoi);
  assert.equal(b.activePoi, null);
  assert.match(b.reasons[1], /approaching an unmitigated 4H/);
});

test('bias: an opposing unmitigated POI weakens it', () => {
  const b = computeBias(TREND_SERIES, {
    structureOpts: { swingLookback: 1, breakOnClose: true },
    // Bias is bearish; price is sitting in unmitigated bullish demand.
    pois: [poi({ direction: 'bullish', top: 100, bottom: 98 })],
    price: 99,
  });
  assert.equal(b.score, 0);
  assert.equal(b.strength, 'weak');
  assert.ok(b.opposingPoi);
  assert.match(b.reasons[1], /opposing unmitigated 4H order block .* bias weakened/);
});

test('bias: aligned and opposing POIs net out', () => {
  const b = computeBias(TREND_SERIES, {
    structureOpts: { swingLookback: 1, breakOnClose: true },
    pois: [
      poi({ direction: 'bearish', top: 100, bottom: 98, index: 2 }),
      poi({ direction: 'bullish', top: 99.5, bottom: 98.5, index: 1 }),
    ],
    price: 99,
  });
  assert.equal(b.score, 1, '+1 aligned, -1 opposing, on top of the base 1');
});

test('bias: mitigated POIs are ignored', () => {
  const b = computeBias(TREND_SERIES, {
    structureOpts: { swingLookback: 1, breakOnClose: true },
    pois: [poi({ direction: 'bearish', top: 100, bottom: 98, mitigated: true })],
    price: 99,
  });
  assert.equal(b.score, 1);
  assert.equal(b.activePoi, null);
});

test('bias: no confirmed structure means no bias', () => {
  const flat = series([
    [100, 100.5, 99.5, 100],
    [100, 100.5, 99.5, 100],
    [100, 100.5, 99.5, 100],
  ]);
  const b = computeBias(flat, { structureOpts: { swingLookback: 1 }, pois: [] });
  assert.equal(b.direction, 'neutral');
  assert.equal(b.strength, 'none');
  assert.equal(b.score, 0);
  assert.match(b.reasons[0], /no confirmed direction/);
});

test('bias: the dealing range comes from the latest impulse leg', () => {
  const b = computeBias(TREND_SERIES, {
    structureOpts: { swingLookback: 1, breakOnClose: true },
    pois: [],
    price: 99,
  });
  assert.equal(b.range.high, b.structure.lastEvent.leg.high);
  assert.equal(b.range.low, b.structure.lastEvent.leg.low);
  assert.equal(b.range.equilibrium, (b.range.high + b.range.low) / 2);
});

test('bias: score is clamped into 0-3', () => {
  const b = computeBias(TREND_SERIES, {
    structureOpts: { swingLookback: 1, breakOnClose: true },
    pois: [
      poi({ direction: 'bullish', top: 100, bottom: 98, index: 3 }),
      poi({ direction: 'bullish', top: 99.6, bottom: 98.4, index: 2 }),
    ],
    price: 99,
  });
  assert.ok(b.score >= 0 && b.score <= 3);
});
