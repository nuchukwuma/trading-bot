'use strict';

const { summarize, bucketBy } = require('./stats');
const { COMBO } = require('./analyze');
const { describeAdjust } = require('../learn/planVariants');

/**
 * The "what worked" report after a backtest: overall numbers, the pairs that
 * paid and the ones that did not, and the conditions the learner found —
 * proven ones (they survived false-discovery control) kept apart from ones
 * that merely look good, so a lucky streak is never presented as an edge.
 */

const FAMILY = {
  session: (v) => `${cap(v.replace('_', '/'))} session`,
  sweep: (v) => (v === 'none' ? 'no liquidity sweep' : `${v.toUpperCase()} sweep`),
  pattern: (v) => `30m ${v.replace(/_/g, ' ')}`,
  htf_pattern: (v) => `4H ${v.replace(/_/g, ' ')}`,
  pa: (v) => v.replace(/_/g, ' '),
  htf_zone: (v) => `price in 4H ${v}`,
  prev_day: (v) => ({ took_high: "took yesterday's high", took_low: "took yesterday's low", took_both: "took both of yesterday's extremes", inside: "inside yesterday's range" })[v] || v,
  momentum: (v) => `momentum ${v} the trade`,
  vol: (v) => `${v} volatility`,
  dow: (v) => cap(v),
  hour: (v) => `${v} UTC`,
  score: (v) => `${v}/6 confirmations`,
  confirm: (v) => `${v.replace(/_/g, ' ')} confirmed`,
  bias: (v) => `${v} 4H bias`,
  dir: (v) => (v === 'bullish' ? 'buys' : 'sells'),
  poi: (v) => `${v.toUpperCase()} entry`,
  shift: (v) => `${v.toUpperCase()} shift`,
  rr: (v) => `R:R ${v}`,
  stop: (v) => `${v.replace('_', ' ')} stop`,
  entry_dist: (v) => ({ at: 'price at the entry', near: 'price near the entry', far: 'price far from the entry' })[v] || v,
  capped: (v) => (v === 'yes' ? 'target capped by liquidity' : 'uncapped targets'),
  instrument: (v) => v,
  kind: (v) => `${v} indices`,
};

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function label(token) {
  return token
    .split(COMBO)
    .map((t) => {
      const [fam, ...rest] = t.split(':');
      const v = rest.join(':');
      return FAMILY[fam] ? FAMILY[fam](v) : t;
    })
    .join(' + ');
}

const R = (n) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}R`;
const PCT = (x) => `${Math.round(x * 100)}%`;
const STATUS = { proven: '🎯', watching: '👀', retired: '🚫' };

/** /playbook — one pair in detail, or every pair's best proven combination. */
function formatPlaybook(playbook, pairId = null) {
  const pairs = (playbook && playbook.pairs) || {};
  const ids = Object.keys(pairs).sort();
  if (!ids.length) return 'No playbook yet — each pair needs about 60 resolved trades. A backtest (/backtest) builds one.';

  if (pairId) {
    const p = pairs[pairId];
    if (!p) return `${pairId} has no playbook yet (not enough trades).`;
    const lines = [`<b>${pairId} playbook</b> — ${p.trades} trades, normally wins ${PCT(p.baseline.winRate)} (avg ${R(p.baseline.avgR)})`];
    if (!p.combos.length) lines.push('No combination beat the normal win rate convincingly.');
    for (const c of p.combos) {
      lines.push('');
      lines.push(`${STATUS[c.status]} <b>${label(c.combo)}</b> — ${c.status}`);
      lines.push(
        `won ${PCT(c.overall.winRate)} of ${c.overall.n} · avg ${R(c.overall.avgR)} ` +
          `(search ${c.search.wins}/${c.search.n}, check ${c.check.wins}/${c.check.n}, live ${c.live.wins}/${c.live.n})`
      );
    }
    return lines.join('\n');
  }

  const lines = ['<b>Playbook</b> — best combination per pair (🎯 proven, 👀 watched)'];
  for (const id of ids) {
    const p = pairs[id];
    const best = p.combos.find((c) => c.status === 'proven') || p.combos.find((c) => c.status === 'watching');
    if (!best) {
      lines.push(`▫️ ${id}: nothing beats its normal ${PCT(p.baseline.winRate)} yet`);
      continue;
    }
    lines.push(
      `${STATUS[best.status]} ${id}: ${label(best.combo)} — won ${PCT(best.overall.winRate)} of ${best.overall.n} vs ${PCT(p.baseline.winRate)} normally`
    );
  }
  lines.push('', '<i>/playbook EURUSD for one pair · /playbook only to send just proven matches on those pairs · /playbook all to undo</i>');
  return lines.join('\n');
}

function buildReport({ trades, result, days, coverage = [] }) {
  const all = summarize(trades);
  const lines = [
    `🔬 <b>Backtest — last ${days} days, ${coverage.length || '?'} pairs</b>`,
    `${all.trades} setups, ${all.n} filled · won ${Math.round(all.winRate * 100)}% · average ${R(all.expectancy)} · total ${R(all.totalR)}`,
  ];

  const short = coverage.filter((c) => c.days < days * 0.8);
  if (short.length) lines.push(`<i>Shorter history for: ${short.map((c) => `${c.id} (${Math.round(c.days)}d)`).join(', ')}</i>`);

  const byPair = bucketBy(trades, (t) => t.instrumentId)
    .filter((b) => b.n >= 10)
    .sort((a, b) => b.expectancy - a.expectancy);
  if (byPair.length) {
    lines.push('', '<b>By pair</b> (average per trade)');
    for (const b of byPair) {
      const mark = b.expectancyLower > 0 ? '🟢' : b.expectancyUpper < 0 ? '🔴' : '🟡';
      lines.push(`${mark} ${b.key}: ${R(b.expectancy)} on ${b.n} · won ${Math.round(b.winRate * 100)}%`);
    }
  }

  const candidates = (result && result.candidates) || [];
  const proven = candidates.filter((c) => c.significant);
  const good = proven.filter((c) => c.diff > 0).slice(0, 8);
  const bad = proven.filter((c) => c.diff < 0).slice(0, 5);
  lines.push('', `<b>What worked</b> — proven (${candidates.length} conditions and combinations tested)`);
  if (!good.length) lines.push('Nothing cleared the evidence bar yet.');
  for (const c of good) {
    lines.push(`✅ ${label(c.feature)}: ${R(c.with.expectancy)} on ${c.with.n} vs ${R(c.without.expectancy)} without`);
  }
  if (bad.length) {
    lines.push('', '<b>What to avoid</b> — proven');
    for (const c of bad) {
      lines.push(`⛔ ${label(c.feature)}: ${R(c.with.expectancy)} on ${c.with.n} vs ${R(c.without.expectancy)} without`);
    }
  }
  const hunches = candidates
    .filter((c) => !c.significant && c.diff > 0 && c.with.n >= 30 && c.p < 0.2)
    .slice(0, 4);
  if (hunches.length) {
    lines.push('', '<b>Promising, not proven yet</b> — watched, not used');
    for (const c of hunches) lines.push(`• ${label(c.feature)}: ${R(c.with.expectancy)} on ${c.with.n} (p=${c.p.toFixed(2)})`);
  }

  if (result) {
    const r = result.rules;
    const parts = [];
    if (r.minScore) parts.push(`score ≥ ${r.minScore}`);
    for (const f of r.requiredFeatures) parts.push(`needs ${label(f)}`);
    for (const f of r.excludedFeatures) parts.push(`avoids ${label(f)}`);
    if (r.minBiasStrength) parts.push(`${r.minBiasStrength}+ 4H bias`);
    if (r.disabledInstruments && r.disabledInstruments.length) parts.push(`skips ${r.disabledInstruments.join(', ')}`);
    lines.push('', '<b>Alert filter</b>');
    lines.push(parts.length ? parts.join(' · ') : 'No filter — nothing proved itself.');
    lines.push(
      result.validated
        ? `✅ Held up on the most recent 30% of trades (${R(result.test.expectancy)} vs ${R(result.unfilteredTest.expectancy)} unfiltered) — now applied.`
        : '⚠️ Did not hold up on the most recent trades — not applied. Every setup that passes the rules is still sent.'
    );
    const adopted = Object.values((result.plan && result.plan.byGroup) || {});
    lines.push('', '<b>Stop and target placement</b>');
    if (!adopted.length) lines.push('Default placement — no alternative proved better.');
    for (const a of adopted) lines.push(`📐 ${a.label}: ${describeAdjust(a)} (${R(a.adjustedR)} vs ${R(a.baselineR)})`);
  }

  if (result && result.playbook) {
    lines.push('', formatPlaybook(result.playbook).replace(/\n\n<i>\/playbook[\s\S]*$/, ''));
  }

  lines.push('', '<i>Figures follow each plan exactly as it would have been sent. Past results are no guarantee.</i>');
  return lines.join('\n');
}

module.exports = { buildReport, label, formatPlaybook };
