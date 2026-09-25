'use strict';

const { mean } = require('../backtest/stats');
const { hasFeature, COMBO } = require('../backtest/analyze');

/**
 * The per-pair playbook: which combinations of conditions win most often on
 * EACH pair — what works on EURUSD need not work on Jump 75.
 *
 * For every pair with enough history:
 *
 *   search   on the earlier 70% of its trades, try every condition alone,
 *            in pairs and in threes, and rank by the PESSIMISTIC end of the
 *            win rate (Wilson lower bound), so 9 wins from 10 cannot outrank
 *            60 from 80. Only combinations that also made money on average
 *            are kept — a high win rate of tiny wins can still lose.
 *   check    each of the best few on the later 30% it never saw. Searching
 *            thousands of combinations guarantees some look brilliant by
 *            chance; only ones that hold up here are marked PROVEN.
 *   monitor  live results are kept apart from backtest ones. A proven
 *            combination whose live record falls clearly below the pair's
 *            normal win rate is RETIRED; a watched one that proves itself
 *            live is PROMOTED.
 *
 * Re-learned after every backtest and every batch of live results, so the
 * playbook keeps building as the bot trades.
 */
const DEFAULTS = {
  minPairTrades: 60, // filled trades on a pair before it gets a playbook
  minComboTrades: 20, // trades a combination needs in the search half
  minCheckTrades: 8, // and in the check half (or live) to be judged
  maxPerPair: 5,
  trainRatio: 0.7,
  tripleTokens: 30, // triples only among this many most common conditions
  maxOverlap: 0.8, // skip a combination that is mostly the same trades as a better one
  minLiveForRetire: 10,
};

const Z_95 = 1.959964;
// The check half tests up to 5 winners per pair: a stricter bar than 95%.
const Z_CHECK = 2.575829;

function wilson(wins, n, z = Z_95) {
  if (n <= 0) return { lower: 0, upper: 1 };
  const p = wins / n;
  const z2 = z * z;
  const d = 1 + z2 / n;
  const c = p + z2 / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { lower: Math.max(0, (c - m) / d), upper: Math.min(1, (c + m) / d) };
}

const isWin = (t) => t.rMultiple > 0;
const isLive = (t) => t.source && t.source !== 'backtest';

function record(trades) {
  const n = trades.length;
  const wins = trades.filter(isWin).length;
  return {
    n,
    wins,
    winRate: n ? wins / n : 0,
    avgR: n ? Number(mean(trades.map((t) => t.rMultiple)).toFixed(4)) : 0,
  };
}

// Conditions that are constant on one pair say nothing about it.
const usableToken = (f) => !/^(instrument|kind):/.test(f);
const family = (f) => f.split(':')[0];

/** Count every single / pair / triple of conditions across `trades`. */
function countCombos(trades, cfg) {
  const freq = new Map();
  for (const t of trades) for (const f of t.features || []) if (usableToken(f)) freq.set(f, (freq.get(f) || 0) + 1);
  const common = new Set([...freq.entries()].filter(([, n]) => n >= cfg.minComboTrades).map(([f]) => f));
  const top = new Set(
    [...freq.entries()]
      .filter(([f]) => common.has(f))
      .sort((a, b) => b[1] - a[1])
      .slice(0, cfg.tripleTokens)
      .map(([f]) => f)
  );

  const stats = new Map();
  const add = (key, t) => {
    let s = stats.get(key);
    if (!s) stats.set(key, (s = { n: 0, wins: 0, sumR: 0 }));
    s.n += 1;
    if (isWin(t)) s.wins += 1;
    s.sumR += t.rMultiple;
  };

  for (const t of trades) {
    const fs = [...new Set(t.features || [])].filter((f) => common.has(f)).sort();
    for (let i = 0; i < fs.length; i += 1) {
      add(fs[i], t);
      for (let j = i + 1; j < fs.length; j += 1) {
        if (family(fs[i]) === family(fs[j])) continue;
        add(`${fs[i]}${COMBO}${fs[j]}`, t);
        if (!top.has(fs[i]) || !top.has(fs[j])) continue;
        for (let k = j + 1; k < fs.length; k += 1) {
          if (!top.has(fs[k]) || family(fs[k]) === family(fs[i]) || family(fs[k]) === family(fs[j])) continue;
          add(`${fs[i]}${COMBO}${fs[j]}${COMBO}${fs[k]}`, t);
        }
      }
    }
  }
  return stats;
}

/**
 * For each condition in a combination: among trades that have all the OTHER
 * conditions, does having this one too win significantly more often?
 * (two-proportion z-test, one-sided, 95%). Singles always pass.
 */
function earnsEveryPart(key, trades) {
  const parts = key.split(COMBO);
  if (parts.length === 1) return true;
  return parts.every((part, i) => {
    const rest = parts.filter((_, j) => j !== i).join(COMBO);
    const within = trades.filter((t) => hasFeature(t.features, rest));
    const a = within.filter((t) => hasFeature(t.features, part));
    const b = within.filter((t) => !hasFeature(t.features, part));
    if (a.length < 5 || b.length < 5) return false;
    const pa = a.filter(isWin).length / a.length;
    const pb = b.filter(isWin).length / b.length;
    const pooled = (a.filter(isWin).length + b.filter(isWin).length) / (a.length + b.length);
    const se = Math.sqrt(pooled * (1 - pooled) * (1 / a.length + 1 / b.length));
    // 99% one-sided: hundreds of combinations get this test.
    return se > 0 && (pa - pb) / se > 2.326348;
  });
}

function learnPairPlaybook(pairTrades, cfg, previous = null) {
  const ordered = [...pairTrades].sort((a, b) => a.time - b.time);
  const splitAt = Math.floor(ordered.length * cfg.trainRatio);
  const search = ordered.slice(0, splitAt);
  const check = ordered.slice(splitAt);
  const baseline = record(ordered);

  // ---- search ----
  const ranked = [...countCombos(search, cfg).entries()]
    .filter(([, s]) => s.n >= cfg.minComboTrades && s.sumR > 0)
    .map(([key, s]) => ({ key, n: s.n, wins: s.wins, lower: wilson(s.wins, s.n).lower }))
    // Must beat the pair's normal win rate even at its pessimistic end.
    .filter((c) => c.lower > record(search).winRate)
    .sort((a, b) => b.lower - a.lower || b.n - a.n);

  // Prefer the simpler combination: skip one whose version with a condition
  // dropped wins nearly as often (pessimistic win rate within 5 points).
  const lowerOf = new Map(ranked.map((c) => [c.key, c.lower]));
  const simplerIsAsGood = (c) => {
    const parts = c.key.split(COMBO);
    if (parts.length === 1) return false;
    return parts.some((_, i) => {
      const parent = parts.filter((__, j) => j !== i).join(COMBO);
      return lowerOf.has(parent) && lowerOf.get(parent) >= c.lower - 0.05;
    });
  };

  const chosen = [];
  for (const c of ranked) {
    if (simplerIsAsGood(c)) continue;
    if (chosen.length >= cfg.maxPerPair) break;
    // Every condition must pull its weight; "a real edge + noise" otherwise
    // outranks the real edge on luck. Judged on the search half only — using
    // the later trades here would leak them into the choice and make the
    // check below easier to pass than it should be.
    if (!earnsEveryPart(c.key, search)) continue;
    const members = new Set(search.filter((t) => hasFeature(t.features, c.key)).map((t) => t.time));
    const redundant = chosen.some((o) => {
      let shared = 0;
      for (const m of members) if (o.members.has(m)) shared += 1;
      return shared / Math.min(members.size, o.members.size) >= cfg.maxOverlap;
    });
    if (!redundant) chosen.push({ ...c, members });
  }

  // ---- check + monitor ----
  // Everything proven or retired before is re-examined too, even if the
  // search no longer picks it — otherwise a combination that starts losing
  // live would silently vanish instead of being retired, and could return.
  const prior = (previous && previous.combos) || [];
  const wasRetired = new Set(prior.filter((c) => c.status === 'retired').map((c) => c.combo));
  const wasProven = new Set(prior.filter((c) => c.status === 'proven').map((c) => c.combo));
  const keys = [...chosen.map((c) => c.key)];
  for (const c of prior) if ((c.status === 'proven' || c.status === 'retired') && !keys.includes(c.combo)) keys.push(c.combo);

  const combos = keys.map((key) => {
    const c = { key };
    const matches = (t) => hasFeature(t.features, c.key);
    const searchRec = record(search.filter(matches));
    const checkTrades = check.filter(matches);
    const checkRec = record(checkTrades.filter((t) => !isLive(t)));
    const liveRec = record(ordered.filter((t) => isLive(t) && matches(t)));
    const holdout = record(checkTrades);

    const passes = (r) => r.n >= cfg.minCheckTrades && r.avgR > 0 && wilson(r.wins, r.n, Z_CHECK).lower > baseline.winRate;
    let status = passes(holdout) ? 'proven' : 'watching';
    if (status === 'watching' && passes(liveRec)) status = 'proven'; // promoted by live results
    // Live results clearly below the pair's normal win rate: stop using it.
    if (liveRec.n >= cfg.minLiveForRetire && wilson(liveRec.wins, liveRec.n).upper < baseline.winRate) status = 'retired';
    if (wasRetired.has(c.key) && !(liveRec.n >= cfg.minCheckTrades && passes(liveRec))) status = 'retired';
    // Proven before, no longer a winner and no longer passing: retire it.
    const stillChosen = chosen.some((x) => x.key === c.key);
    if (wasProven.has(c.key) && !stillChosen && status !== 'proven') status = 'retired';

    return {
      combo: c.key,
      status,
      search: searchRec,
      check: checkRec,
      live: liveRec,
      overall: record(ordered.filter(matches)),
    };
  });

  // Retired ones are kept (so they stay retired) but capped.
  const active = combos.filter((c) => c.status !== 'retired');
  const retired = combos.filter((c) => c.status === 'retired').slice(0, 10);
  return { trades: ordered.length, baseline, combos: [...active, ...retired] };
}

function learnPlaybook(trades, cfg = {}, previous = null) {
  const c = { ...DEFAULTS, ...cfg.playbook };
  const byPair = new Map();
  for (const t of trades) {
    if (!t.filled) continue;
    if (!byPair.has(t.instrumentId)) byPair.set(t.instrumentId, []);
    byPair.get(t.instrumentId).push(t);
  }
  const pairs = {};
  const notes = [];
  for (const [id, list] of byPair) {
    if (list.length < c.minPairTrades) {
      notes.push(`${id}: ${list.length} trades — ${c.minPairTrades} needed for a playbook.`);
      continue;
    }
    pairs[id] = learnPairPlaybook(list, c, previous && previous.pairs && previous.pairs[id]);
    const proven = pairs[id].combos.filter((x) => x.status === 'proven').length;
    notes.push(`${id}: ${proven} proven combination(s), ${pairs[id].combos.length - proven} watched or retired.`);
  }
  return { pairs, notes, learnedAt: new Date().toISOString() };
}

/** The playbook combinations a live setup on `instrumentId` matches, best first. */
function matchPlaybook(playbook, instrumentId, features) {
  const pair = playbook && playbook.pairs && playbook.pairs[instrumentId];
  if (!pair) return { hasProven: false, matches: [] };
  const matches = pair.combos
    .filter((c) => c.status !== 'retired' && hasFeature(features, c.combo))
    .sort((a, b) => (a.status === 'proven' ? -1 : 1) - (b.status === 'proven' ? -1 : 1) || b.overall.winRate - a.overall.winRate);
  return { hasProven: pair.combos.some((c) => c.status === 'proven'), baseline: pair.baseline, matches };
}

module.exports = { learnPlaybook, learnPairPlaybook, matchPlaybook, wilson, PLAYBOOK_DEFAULTS: DEFAULTS };
