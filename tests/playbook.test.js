'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { learnPlaybook, matchPlaybook } = require('../src/learn/playbook');
const { mulberry32 } = require('../src/backtest/randomWalk');

const NOISE = ['dow:mon', 'dow:tue', 'dow:wed', 'vol:high', 'vol:low', 'pattern:inside_bar', 'pattern:pin_bar_bull', 'poi:ob', 'poi:fvg', 'rr:2.0-2.5', 'momentum:flat', 'htf_zone:discount'];

/**
 * Trades for one pair. `edge(f)` says which feature set wins more often;
 * everything else wins at `base`.
 */
function pairTrades({ id, n, seed, edge = () => false, edgeWin = 0.8, base = 0.35, startTime = 0, source = 'backtest' }) {
  const rand = mulberry32(seed);
  return Array.from({ length: n }, (_, i) => {
    const f = [
      `instrument:${id}`,
      rand() < 0.45 ? 'session:london' : 'session:ny',
      rand() < 0.4 ? 'sweep:eql' : 'sweep:none',
      rand() < 0.35 ? 'shift:choch' : 'shift:bos',
    ];
    for (const t of NOISE) if (rand() < 0.3) f.push(t);
    const win = rand() < (edge(f) ? edgeWin : base);
    return { instrumentId: id, time: startTime + i, features: f, filled: true, rMultiple: win ? 2 : -1, source };
  });
}

const londonEql = (f) => f.includes('session:london') && f.includes('sweep:eql');
const chochNy = (f) => f.includes('shift:choch') && f.includes('session:ny');

test('playbook: finds a different winning combination on each pair', () => {
  const trades = [
    ...pairTrades({ id: 'EURUSD', n: 500, seed: 1, edge: londonEql }),
    ...pairTrades({ id: 'VOL75', n: 500, seed: 2, edge: chochNy }),
  ];
  const pb = learnPlaybook(trades);
  const proven = (id) => pb.pairs[id].combos.filter((c) => c.status === 'proven');
  const inside = (combo, parts) => parts.every((p) => combo.split(' & ').includes(p));

  // Every proven combination sits inside the real edge — it may be refined
  // by one more condition the data happens to favour, but never outside it.
  assert.ok(proven('EURUSD').length > 0);
  for (const c of proven('EURUSD')) assert.ok(inside(c.combo, ['session:london', 'sweep:eql']), c.combo);
  assert.ok(proven('VOL75').length > 0);
  for (const c of proven('VOL75')) assert.ok(inside(c.combo, ['session:ny', 'shift:choch']), c.combo);

  const top = proven('EURUSD')[0];
  assert.ok(top.overall.winRate > 0.65);
  assert.ok(top.overall.avgR > 0);
});

test('playbook: pure noise proves nothing, however many combinations are tried', () => {
  let proven = 0;
  for (const seed of [11, 12, 13]) {
    const pb = learnPlaybook(pairTrades({ id: 'EURUSD', n: 500, seed }));
    proven += pb.pairs.EURUSD.combos.filter((c) => c.status === 'proven').length;
  }
  assert.equal(proven, 0);
});

test('playbook: a pair without enough trades waits', () => {
  const pb = learnPlaybook(pairTrades({ id: 'EURUSD', n: 40, seed: 3, edge: londonEql }));
  assert.equal(pb.pairs.EURUSD, undefined);
  assert.match(pb.notes[0], /60 needed/);
});

test('playbook: a proven combination that loses live is retired, and stays retired', () => {
  const backtest = pairTrades({ id: 'EURUSD', n: 500, seed: 1, edge: londonEql });
  const first = learnPlaybook(backtest);
  const isEdge = (c) => c.combo.includes('session:london') && c.combo.includes('sweep:eql');
  const target = first.pairs.EURUSD.combos.find((c) => isEdge(c) && c.status === 'proven');
  assert.ok(target, 'the edge is proven in the backtest');

  // Live: the combination now loses almost every time.
  const live = pairTrades({ id: 'EURUSD', n: 200, seed: 5, edge: londonEql, edgeWin: 0.02, startTime: 10000, source: 'live' });
  const second = learnPlaybook([...backtest, ...live], {}, first);
  const c = second.pairs.EURUSD.combos.find((x) => x.combo === target.combo);
  assert.ok(c, 'still tracked');
  assert.equal(c.status, 'retired');
  assert.ok(c.live.n >= 10);
  const features = target.combo.split(' & ');
  assert.ok(!matchPlaybook(second, 'EURUSD', features).matches.some((m) => m.combo === target.combo), 'retired combos are not matched');
});

test('playbook: a watched combination is promoted by live results', () => {
  // Weak in the backtest (so only watched), strong live.
  const backtest = pairTrades({ id: 'EURUSD', n: 300, seed: 21, edge: londonEql, edgeWin: 0.55 });
  const live = pairTrades({ id: 'EURUSD', n: 400, seed: 22, edge: londonEql, edgeWin: 0.9, startTime: 10000, source: 'live' });
  const pb = learnPlaybook([...backtest, ...live]);
  const c = pb.pairs.EURUSD.combos.find((x) => x.combo.includes('session:london') && x.combo.includes('sweep:eql'));
  assert.ok(c && c.status === 'proven', `status ${c && c.status}`);
  assert.ok(c.live.n > 0);
});

test('playbook: matching returns proven combinations first', () => {
  const pb = {
    pairs: {
      EURUSD: {
        baseline: { winRate: 0.35 },
        combos: [
          { combo: 'vol:high', status: 'watching', overall: { winRate: 0.9 } },
          { combo: 'session:london & sweep:eql', status: 'proven', overall: { winRate: 0.7 } },
          { combo: 'dow:mon', status: 'retired', overall: { winRate: 0.95 } },
        ],
      },
    },
  };
  const m = matchPlaybook(pb, 'EURUSD', ['vol:high', 'session:london', 'sweep:eql', 'dow:mon']);
  assert.equal(m.hasProven, true);
  assert.deepEqual(m.matches.map((x) => x.combo), ['session:london & sweep:eql', 'vol:high']);
  assert.deepEqual(matchPlaybook(pb, 'GBPUSD', ['vol:high']).matches, []);
});
