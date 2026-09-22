'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { detectOrderBlocks } = require('../src/poi/orderBlocks');
const { detectFVGs } = require('../src/poi/fvg');
const {
  updateMitigation,
  proximalEdge,
  distalEdge,
  isApproaching,
  isReactingTo,
  zonesOverlap,
  overlapRatio,
  describePoi,
  height,
} = require('../src/poi/mitigation');
const { buildPOIs, unmitigated, nearestUnmitigated, poisContaining, overlappingPOIs } = require('../src/poi');
const { c, noise, BASE_TIME } = require('./helpers/candles');

const TF = 1800;
const at = (i) => BASE_TIME + i * TF;

/**
 * 20 quiet candles (avg range 1.0), then:
 *   20: bearish candle 99.5-100.5   <- the bullish order block
 *   21: bullish displacement to 103 <- drives the move, leaves a gap
 *   22: continuation, low 103       <- completes a bullish FVG over 100.5-103
 */
function bullishSetup(extra = []) {
  return [
    ...noise(20, 100),
    c(at(20), 100.2, 100.5, 99.5, 99.6), // bearish OB candle
    c(at(21), 99.6, 103.2, 99.5, 103.0), // displacement, body 3.4
    c(at(22), 103.0, 104.0, 103.0, 103.8),
    ...extra,
  ];
}

test('order blocks: finds the last down candle before a displacing up-move', () => {
  const obs = detectOrderBlocks(bullishSetup());
  const bullish = obs.filter((o) => o.direction === 'bullish');
  assert.equal(bullish.length, 1);
  assert.equal(bullish[0].index, 20);
  assert.equal(bullish[0].top, 100.5);
  assert.equal(bullish[0].bottom, 99.5);
  assert.equal(bullish[0].kind, 'OB');
  assert.ok(bullish[0].strength > 2, 'impulse travelled >2x the average range');
  assert.equal(bullish[0].displacementIndex, 21);
});

test('order blocks: mirror case finds bearish blocks', () => {
  const candles = [
    ...noise(20, 100),
    c(at(20), 99.8, 100.5, 99.5, 100.4), // bullish OB candle
    c(at(21), 100.4, 100.5, 96.8, 97.0), // bearish displacement, body 3.4
    c(at(22), 97.0, 97.0, 96.0, 96.2),
  ];
  const obs = detectOrderBlocks(candles).filter((o) => o.direction === 'bearish');
  assert.equal(obs.length, 1);
  assert.equal(obs[0].index, 20);
  assert.equal(obs[0].top, 100.5);
  assert.equal(obs[0].bottom, 99.5);
});

test('order blocks: a weak move away is rejected', () => {
  const candles = [
    ...noise(20, 100),
    c(at(20), 100.2, 100.5, 99.5, 99.6),
    c(at(21), 99.6, 100.7, 99.5, 100.6), // only 0.2 beyond the OB high
    c(at(22), 100.6, 100.8, 100.4, 100.7),
  ];
  assert.deepEqual(detectOrderBlocks(candles).filter((o) => o.direction === 'bullish'), []);
});

test('order blocks: requireDisplacement filters out non-displacing impulses', () => {
  // Travel is far enough, but spread over small candles with no displacement.
  const candles = [
    ...noise(20, 100),
    c(at(20), 100.2, 100.5, 99.5, 99.6),
    c(at(21), 99.6, 100.4, 99.5, 100.3),
    c(at(22), 100.3, 101.2, 100.2, 101.1),
    c(at(23), 101.1, 102.0, 101.0, 101.9),
    c(at(24), 101.9, 102.8, 101.8, 102.7),
  ];
  assert.equal(detectOrderBlocks(candles, { requireDisplacement: true }).filter((o) => o.direction === 'bullish').length, 0);
  assert.equal(detectOrderBlocks(candles, { requireDisplacement: false }).filter((o) => o.direction === 'bullish').length, 1);
});

test('fvg: a three-candle bullish gap is captured with the right bounds', () => {
  const fvgs = detectFVGs(bullishSetup()).filter((f) => f.direction === 'bullish');
  assert.equal(fvgs.length, 1);
  assert.equal(fvgs[0].index, 22, 'anchored at the candle that completed the gap');
  assert.equal(fvgs[0].bottom, 100.5, 'gap bottom is the first candle high');
  assert.equal(fvgs[0].top, 103.0, 'gap top is the third candle low');
});

test('fvg: bearish gap and the no-gap case', () => {
  const bearish = [
    ...noise(20, 100),
    c(at(20), 100.0, 100.5, 99.5, 99.8),
    c(at(21), 99.8, 99.9, 96.5, 96.6),
    c(at(22), 96.6, 97.0, 96.0, 96.4), // high 97.0 < low(20) 99.5 -> bearish FVG 97.0-99.5
  ];
  const f = detectFVGs(bearish).filter((x) => x.direction === 'bearish');
  assert.equal(f.length, 1);
  assert.equal(f[0].bottom, 97.0);
  assert.equal(f[0].top, 99.5);

  assert.deepEqual(detectFVGs(noise(20, 100)), [], 'overlapping candles leave no gap');
});

test('fvg: gaps thinner than minGapFactor are discarded as noise', () => {
  const tiny = [
    ...noise(20, 100),
    c(at(20), 100.0, 100.2, 99.9, 100.1),
    c(at(21), 100.1, 100.4, 100.0, 100.35),
    c(at(22), 100.35, 100.5, 100.25, 100.45), // gap of 0.05 vs avg range ~1
  ];
  assert.deepEqual(detectFVGs(tiny, { minGapFactor: 0.1 }), []);
  assert.equal(detectFVGs(tiny, { minGapFactor: 0.01 }).length, 1);
});

test('mitigation: zone edges are oriented by direction', () => {
  const demand = { direction: 'bullish', top: 100.5, bottom: 99.5 };
  const supply = { direction: 'bearish', top: 100.5, bottom: 99.5 };
  assert.equal(proximalEdge(demand), 100.5, 'price meets demand at its top');
  assert.equal(distalEdge(demand), 99.5);
  assert.equal(proximalEdge(supply), 99.5, 'price meets supply at its bottom');
  assert.equal(distalEdge(supply), 100.5);
  assert.equal(height(demand), 1);
});

test('mitigation: a shallow tag leaves the zone unmitigated, a deep one mitigates it', () => {
  const poi = { kind: 'OB', direction: 'bullish', index: 0, time: at(0), top: 100.5, bottom: 99.5 };
  const shallow = [c(at(0), 100, 100.5, 99.5, 99.6), c(at(1), 101, 101.5, 100.4, 101.2)];
  const deep = [c(at(0), 100, 100.5, 99.5, 99.6), c(at(1), 101, 101.5, 99.9, 101.2)];

  const a = updateMitigation(poi, shallow, { mitigationFillRatio: 0.5 });
  assert.equal(a.touched, true);
  assert.equal(a.mitigated, false);
  assert.ok(Math.abs(a.fill - 0.1) < 1e-9);

  const b = updateMitigation(poi, deep, { mitigationFillRatio: 0.5 });
  assert.equal(b.mitigated, true);
  assert.equal(b.mitigatedIndex, 1);
  assert.equal(b.mitigatedTime, at(1));
  assert.ok(Math.abs(b.fill - 0.6) < 1e-9);
});

test('mitigation: untouched zones stay clean and the input is not mutated', () => {
  const poi = { kind: 'OB', direction: 'bullish', index: 0, time: at(0), top: 100.5, bottom: 99.5 };
  const away = [c(at(0), 100, 100.5, 99.5, 99.6), c(at(1), 102, 103, 101.5, 102.5)];
  const out = updateMitigation(poi, away);
  assert.equal(out.touched, false);
  assert.equal(out.mitigated, false);
  assert.equal(out.fill, 0);
  assert.equal(poi.mitigated, undefined, 'original poi untouched');
});

test('mitigation: a close beyond the distal edge marks the zone violated', () => {
  const poi = { kind: 'OB', direction: 'bullish', index: 0, time: at(0), top: 100.5, bottom: 99.5 };
  const broken = [c(at(0), 100, 100.5, 99.5, 99.6), c(at(1), 100, 100.2, 98.0, 98.5)];
  const out = updateMitigation(poi, broken);
  assert.equal(out.violated, true);
  assert.equal(out.mitigated, true);

  const supply = { kind: 'OB', direction: 'bearish', index: 0, time: at(0), top: 100.5, bottom: 99.5 };
  const rallied = [c(at(0), 100, 100.5, 99.5, 100.4), c(at(1), 100, 102, 99.8, 101.5)];
  assert.equal(updateMitigation(supply, rallied).violated, true);
});

test('mitigation: a zero-height zone is mitigated by any touch', () => {
  const flat = { kind: 'FVG', direction: 'bullish', index: 0, time: at(0), top: 100, bottom: 100 };
  const out = updateMitigation(flat, [c(at(0), 100, 100, 100, 100), c(at(1), 101, 101, 99.9, 100.5)]);
  assert.equal(out.mitigated, true);
  assert.equal(out.fill, 1);
});

test('mitigation: reacting vs approaching a zone', () => {
  const demand = { direction: 'bullish', top: 100.5, bottom: 99.5 };
  assert.equal(isReactingTo(demand, 100.0), true);
  assert.equal(isReactingTo(demand, 101.0), false);

  // Approaching from above, within 1.5 zone-heights (1.5 price units) of the top.
  assert.equal(isApproaching(demand, 101.4, { approachZoneMultiple: 1.5 }), true);
  assert.equal(isApproaching(demand, 102.5, { approachZoneMultiple: 1.5 }), false);
  assert.equal(isApproaching(demand, 100.0, { approachZoneMultiple: 1.5 }), false, 'inside is reacting, not approaching');
  assert.equal(isApproaching(demand, 98.0, { approachZoneMultiple: 1.5 }), false, 'below the zone is not approaching it');

  const supply = { direction: 'bearish', top: 100.5, bottom: 99.5 };
  assert.equal(isApproaching(supply, 98.6, { approachZoneMultiple: 1.5 }), true);
  assert.equal(isApproaching(supply, 97.0, { approachZoneMultiple: 1.5 }), false);
});

test('mitigation: zone overlap detection and ratio', () => {
  const a = { top: 101, bottom: 100 };
  const b = { top: 100.5, bottom: 99 };
  assert.equal(zonesOverlap(a, b), true);
  assert.equal(overlapRatio(a, b), 0.5);
  assert.equal(zonesOverlap(a, { top: 99.9, bottom: 99 }), false);
  assert.equal(overlapRatio(a, { top: 99.9, bottom: 99 }), 0);
  assert.match(describePoi({ kind: 'OB', direction: 'bullish', top: 100.5, bottom: 99.5, mitigated: false }), /unmitigated bullish order block/);
});

test('tracker: builds POIs, resolves mitigation and caps the live set', () => {
  const pois = buildPOIs(bullishSetup(), { timeframe: '4h', maxTracked: 10 });
  assert.ok(pois.length >= 2, 'at least the OB and the FVG');
  const ob = pois.find((p) => p.kind === 'OB' && p.direction === 'bullish');
  const fvg = pois.find((p) => p.kind === 'FVG' && p.direction === 'bullish');
  assert.equal(ob.timeframe, '4h');
  assert.equal(ob.proximal, 100.5);
  assert.equal(ob.distal, 99.5);
  assert.equal(ob.mitigated, false, 'price never came back');
  assert.ok(ob.id.startsWith('4h:OB:bullish:'));
  assert.equal(fvg.height, 2.5);
  assert.ok(pois[0].index >= pois[pois.length - 1].index, 'newest first');

  const capped = buildPOIs(bullishSetup(), { timeframe: '4h', maxTracked: 1 });
  assert.equal(capped.length, 1);
});

test('tracker: age filter drops stale POIs', () => {
  const stale = buildPOIs([...bullishSetup(), ...noise(30, 110, { start: at(23) })], {
    timeframe: '4h',
    maxAgeCandles: 5,
  });
  assert.equal(stale.every((p) => p.age <= 5), true);
});

test('tracker: unmitigated / nearest / containing / overlapping queries', () => {
  const pois = [
    { id: 'a', direction: 'bullish', kind: 'OB', index: 5, top: 100, bottom: 99, mitigated: false, violated: false },
    { id: 'b', direction: 'bullish', kind: 'OB', index: 4, top: 95, bottom: 94, mitigated: false, violated: false },
    { id: 'c', direction: 'bullish', kind: 'OB', index: 3, top: 98, bottom: 97, mitigated: true, violated: false },
    { id: 'd', direction: 'bearish', kind: 'OB', index: 2, top: 110, bottom: 109, mitigated: false, violated: false },
    { id: 'e', direction: 'bearish', kind: 'OB', index: 1, top: 120, bottom: 119, mitigated: false, violated: true },
  ];

  assert.deepEqual(unmitigated(pois).map((p) => p.id), ['a', 'b', 'd']);
  assert.deepEqual(unmitigated(pois, 'bullish').map((p) => p.id), ['a', 'b']);

  assert.equal(nearestUnmitigated(pois, 105, 'bullish').id, 'a', 'closest demand below price');
  assert.equal(nearestUnmitigated(pois, 105, 'bearish').id, 'd', 'closest supply above price');
  assert.equal(nearestUnmitigated(pois, 90, 'bullish'), null, 'no demand below price');

  assert.deepEqual(poisContaining(pois, 99.5).map((p) => p.id), ['a']);
  assert.deepEqual(overlappingPOIs(pois, { top: 99.5, bottom: 94.5 }).map((p) => p.id), ['a', 'b']);
});

test('tracker: a genuine return into the order block does mitigate it', () => {
  // Same setup, then price rotates back down into the 99.5-100.5 block.
  const pois = buildPOIs(
    bullishSetup([
      c(at(23), 103.8, 104.2, 102.0, 102.5),
      c(at(24), 102.5, 102.6, 100.0, 100.2), // trades to 100.0 -> 50% of the block
    ]),
    { timeframe: '4h', mitigationFillRatio: 0.5 }
  );
  const ob = pois.find((p) => p.kind === 'OB' && p.direction === 'bullish');
  assert.equal(ob.mitigated, true);
  assert.equal(ob.touchedTime, at(24));
  assert.equal(unmitigated(pois, 'bullish').some((p) => p.kind === 'OB'), false);
});

test('tracker: the impulse candle that created the block never mitigates it', () => {
  // The displacement candle at index 21 has its low inside the block; that is
  // the move away, not a return, so the block must stay live.
  const ob = buildPOIs(bullishSetup(), { timeframe: '4h' }).find((p) => p.kind === 'OB');
  assert.equal(ob.mitigated, false);
  assert.equal(ob.touched, false);
  assert.ok(ob.mitigationFrom > 21);
});
