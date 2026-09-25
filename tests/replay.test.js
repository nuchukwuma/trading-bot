'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { replayInstrument, replayAll } = require('../src/backtest/replay');
const { randomWalkSeries } = require('../src/backtest/randomWalk');
const { EdgeProfile, PROFILE_VERSION } = require('../src/backtest/edgeProfile');

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

const OPTS = { warmupBars: 120, tailBars: 96, simulator: { maxBars: 96 } };

test('replay: produces trades with the fields the analyser needs', () => {
  const { ltf, htf } = randomWalkSeries({ bars: 2500, seed: 11 });
  const run = replayInstrument({ instrument: INSTRUMENT, htf, ltf, opts: OPTS });

  assert.ok(run.trades.length > 5, `expected trades, got ${run.trades.length}`);
  for (const t of run.trades) {
    assert.equal(t.instrumentId, 'SYN');
    assert.ok(['bullish', 'bearish'].includes(t.direction));
    assert.ok(t.score >= 3 && t.score <= 6);
    assert.ok(Array.isArray(t.confirmations) && t.confirmations.length === t.score);
    assert.equal(t.confirmationSignature, t.confirmations.join('+'));
    assert.ok(Number.isFinite(t.rMultiple));
    assert.ok(Number.isFinite(t.riskDistance) && t.riskDistance > 0);
    assert.ok(t.riskReward >= 2, 'every trade cleared the R:R gate');
  }
});

test('replay: confirmation ids are sorted so signatures are comparable', () => {
  const { ltf, htf } = randomWalkSeries({ bars: 2000, seed: 12 });
  const { trades } = replayAll({ series: [{ instrument: INSTRUMENT, htf, ltf }], opts: OPTS });
  for (const t of trades) {
    assert.deepEqual(t.confirmations, [...t.confirmations].sort());
  }
});

test('replay: no look-ahead — appending future candles cannot change past trades', () => {
  // The strongest property available: replay a prefix, then replay a longer
  // series. Every signal that had room to resolve inside the prefix must come
  // out byte-for-byte identical.
  const { ltf, htf } = randomWalkSeries({ bars: 3000, seed: 13 });
  const cut = 1500;

  const shortRun = replayInstrument({
    instrument: INSTRUMENT,
    htf: htf.filter((c) => c.time < ltf[cut].time),
    ltf: ltf.slice(0, cut),
    opts: OPTS,
  });
  const longRun = replayInstrument({ instrument: INSTRUMENT, htf, ltf, opts: OPTS });

  assert.ok(shortRun.trades.length > 0, 'the prefix produced trades to compare');

  const longByBar = new Map(longRun.trades.map((t) => [t.barIndex, t]));
  let compared = 0;
  for (const early of shortRun.trades) {
    const later = longByBar.get(early.barIndex);
    assert.ok(later, `trade at bar ${early.barIndex} vanished when more data was added`);
    assert.deepEqual(
      { d: early.direction, s: early.score, e: early.entryPrice, sl: early.stopPrice, c: early.confirmations },
      { d: later.direction, s: later.score, e: later.entryPrice, sl: later.stopPrice, c: later.confirmations },
      `the decision at bar ${early.barIndex} changed once the future was visible`
    );
    compared += 1;
  }
  assert.ok(compared > 0);
});

test('replay: outcomes of fully-resolved trades are stable as data is extended', () => {
  const { ltf, htf } = randomWalkSeries({ bars: 3000, seed: 14 });
  const cut = 1600;
  const shortRun = replayInstrument({
    instrument: INSTRUMENT,
    htf: htf.filter((c) => c.time < ltf[cut].time),
    ltf: ltf.slice(0, cut),
    opts: OPTS,
  });
  const longRun = replayInstrument({ instrument: INSTRUMENT, htf, ltf, opts: OPTS });
  const longByBar = new Map(longRun.trades.map((t) => [t.barIndex, t]));

  for (const early of shortRun.trades) {
    // Only trades that resolved without running out of candles are comparable;
    // a timeout in the prefix legitimately becomes a real outcome later.
    if (early.status === 'timeout') continue;
    const later = longByBar.get(early.barIndex);
    assert.equal(later.status, early.status, `outcome at bar ${early.barIndex} changed`);
    assert.ok(Math.abs(later.rMultiple - early.rMultiple) < 1e-9);
  }
});

test('replay: de-duplication suppresses repeats, matching live behaviour', () => {
  const { ltf, htf } = randomWalkSeries({ bars: 2500, seed: 15 });
  const deduped = replayInstrument({ instrument: INSTRUMENT, htf, ltf, opts: OPTS });
  const raw = replayInstrument({ instrument: INSTRUMENT, htf, ltf, opts: { ...OPTS, applyDedup: false } });

  assert.ok(raw.trades.length > deduped.trades.length, 'the same POI re-fires without de-duplication');
  assert.ok(deduped.skipped.dedup > 0);
});

test('replay: warmup and tail are respected', () => {
  const { ltf, htf } = randomWalkSeries({ bars: 2000, seed: 16 });
  const run = replayInstrument({ instrument: INSTRUMENT, htf, ltf, opts: { ...OPTS, warmupBars: 300, tailBars: 200 } });

  for (const t of run.trades) {
    assert.ok(t.barIndex >= 300, 'no trade before the warmup');
    assert.ok(t.barIndex < ltf.length - 200, 'no trade inside the reserved tail');
  }
  assert.equal(run.evaluatedBars, ltf.length - 200 - 300);
});

test('replay: skip counters account for every evaluated bar', () => {
  const { ltf, htf } = randomWalkSeries({ bars: 2000, seed: 17 });
  const run = replayInstrument({ instrument: INSTRUMENT, htf, ltf, opts: OPTS });
  const skipped = Object.values(run.skipped).reduce((a, b) => a + b, 0);
  assert.equal(skipped + run.trades.length, run.evaluatedBars);
});

test('replay: pooling several instruments orders trades chronologically', () => {
  const a = randomWalkSeries({ bars: 1500, seed: 18 });
  const b = randomWalkSeries({ bars: 1500, seed: 19 });
  const { trades, runs } = replayAll({
    series: [
      { instrument: INSTRUMENT, htf: a.htf, ltf: a.ltf },
      { instrument: { ...INSTRUMENT, id: 'SYN2' }, htf: b.htf, ltf: b.ltf },
    ],
    opts: OPTS,
  });
  assert.equal(runs.length, 2);
  for (let i = 1; i < trades.length; i += 1) {
    assert.ok(trades[i].time >= trades[i - 1].time, 'pooled trades are in time order');
  }
});

// ---------------------------------------------------------------- profile io
function tmpProfile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'edge-')), 'edge-profile.json');
}

const SETUP = {
  instrumentId: 'VOL75',
  direction: 'bullish',
  score: 5,
  confirmations: ['ltf_structure', 'liquidity_sweep'],
  biasStrength: 'moderate',
};

const RULES = {
  minScore: 4,
  requiredConfirmations: ['liquidity_sweep'],
  minBiasStrength: null,
  disabledInstruments: [],
  allowedDirections: null,
};

test('profile: a missing file allows everything but says so', () => {
  const p = EdgeProfile.load(path.join(os.tmpdir(), 'definitely-not-here.json'));
  assert.equal(p.loaded, false);
  assert.equal(p.active, false);
  const v = p.evaluate(SETUP);
  assert.equal(v.allow, true);
  assert.match(v.reason, /No edge profile/);
  assert.match(p.describe(), /no edge profile loaded/);
});

test('profile: EDGE_PROFILE_REQUIRED blocks everything until one exists', () => {
  const p = EdgeProfile.load(path.join(os.tmpdir(), 'nope.json'), { required: true });
  const v = p.evaluate(SETUP);
  assert.equal(v.allow, false);
  assert.match(v.reason, /run npm run backtest/);
});

test('profile: a validated profile round-trips and filters', () => {
  const file = tmpProfile();
  EdgeProfile.save(file, {
    rules: RULES,
    validated: true,
    notes: ['ok'],
    train: { n: 100 },
    test: { n: 40 },
    unfilteredTest: { n: 90 },
  });

  const p = EdgeProfile.load(file);
  assert.equal(p.loaded, true);
  assert.equal(p.validated, true);
  assert.equal(p.active, true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, PROFILE_VERSION);

  assert.equal(p.evaluate(SETUP).allow, true);
  assert.match(p.evaluate(SETUP).reason, /Matches the backtested profile/);

  const lowScore = p.evaluate({ ...SETUP, score: 3 });
  assert.equal(lowScore.allow, false);
  assert.match(lowScore.reason, /below the backtested minimum of 4/);

  const noSweep = p.evaluate({ ...SETUP, confirmations: ['ltf_structure'] });
  assert.equal(noSweep.allow, false);
  assert.match(noSweep.reason, /Missing confirmation\(s\).*liquidity_sweep/);
});

test('profile: an unvalidated profile is loaded but not enforced', () => {
  const file = tmpProfile();
  EdgeProfile.save(file, { rules: RULES, validated: false, notes: [], train: {}, test: {}, unfilteredTest: {} });

  const lenient = EdgeProfile.load(file);
  assert.equal(lenient.loaded, true);
  assert.equal(lenient.active, false);
  const v = lenient.evaluate({ ...SETUP, score: 1 });
  assert.equal(v.allow, true, 'rules fitted to their own data are worse than no filter');
  assert.match(v.reason, /failed out-of-sample validation/);
  assert.match(lenient.describe(), /UNVALIDATED, not enforced/);

  const forced = EdgeProfile.load(file, { enforceUnvalidated: true });
  assert.equal(forced.active, true);
  assert.equal(forced.evaluate({ ...SETUP, score: 1 }).allow, false);

  const strict = EdgeProfile.load(file, { required: true });
  assert.equal(strict.evaluate(SETUP).allow, false);
});

test('profile: disabled instruments and bias floors are explained', () => {
  const file = tmpProfile();
  EdgeProfile.save(file, {
    rules: { ...RULES, disabledInstruments: ['JUMP100'], minBiasStrength: 'strong' },
    validated: true,
    notes: [],
    train: {},
    test: {},
    unfilteredTest: {},
  });
  const p = EdgeProfile.load(file);

  const blocked = p.evaluate({ ...SETUP, instrumentId: 'JUMP100', biasStrength: 'strong' });
  assert.equal(blocked.allow, false);
  assert.match(blocked.reason, /JUMP100 showed no edge/);

  const weak = p.evaluate({ ...SETUP, biasStrength: 'moderate' });
  assert.equal(weak.allow, false);
  assert.match(weak.reason, /below the backtested minimum "strong"/);

  assert.match(p.describe(), /excludes JUMP100/);
});

test('profile: a future version is ignored rather than mis-read', () => {
  const file = tmpProfile();
  fs.writeFileSync(file, JSON.stringify({ version: 999, rules: RULES, validated: true }));
  const p = EdgeProfile.load(file);
  assert.equal(p.loaded, false);
  assert.equal(p.evaluate(SETUP).allow, true);
});

test('profile: a corrupt file does not take the bot down', () => {
  const file = tmpProfile();
  fs.writeFileSync(file, '{ not json');
  const p = EdgeProfile.load(file);
  assert.equal(p.loaded, false);
  assert.equal(p.evaluate(SETUP).allow, true);
});

test('replay: every trade carries its alternative-placement results, baseline equal to its own R', () => {
  const { BASELINE } = require('../src/learn/planVariants');
  const { ltf, htf } = randomWalkSeries({ bars: 2500, seed: 11 });
  const run = replayInstrument({ instrument: INSTRUMENT, htf, ltf, opts: OPTS });
  assert.ok(run.trades.length > 5);
  for (const t of run.trades) {
    assert.equal(Object.keys(t.variants).length, 12);
    // Uncapped trades replay identically; capped ones differ only by the cap.
    if (!t.targetCapped) assert.ok(Math.abs(t.variants[BASELINE()] - (t.filled ? t.rMultiple : 0)) < 1e-3);
  }
});
