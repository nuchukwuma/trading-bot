'use strict';

const { summarize } = require('../backtest/stats');

/**
 * "Is this a high-probability setup?" — answered from the bot's own record.
 *
 * The ledger (backtest seed + every live setup the bot has resolved) is
 * searched for trades like this one, from the most specific group to the most
 * general, and the first group with enough trades to mean something is used:
 *
 *   same pair, same score  ->  same pair  ->  same market type, same score
 *   ->  every pair, same score  ->  everything
 *
 * The grade is read off the 95% interval on average R, not the raw win rate,
 * so a lucky streak of 8 trades does not read as an edge:
 *
 *   high     even the pessimistic end of the interval is profitable
 *   low      even the optimistic end loses money
 *   neutral  the evidence does not point either way yet
 *   unknown  no group has enough trades
 */
const GRADES = {
  high: { icon: '🟢', label: 'High probability' },
  neutral: { icon: '🟡', label: 'No clear edge yet' },
  low: { icon: '🔴', label: 'Low probability' },
  unknown: { icon: '⚪️', label: 'Not enough history yet' },
};

function rateSetup(trades, setup, { minSamples = 30, kindOf = () => null } = {}) {
  const filled = trades.filter((t) => t.filled);
  const kind = setup.instrumentKind || kindOf(setup.instrumentId);
  const tradeKind = (t) => t.instrumentKind || kindOf(t.instrumentId);

  const cohorts = [
    { label: `${setup.instrumentId} at ${setup.score}/6`, match: (t) => t.instrumentId === setup.instrumentId && t.score === setup.score },
    { label: `${setup.instrumentId}, any score`, match: (t) => t.instrumentId === setup.instrumentId },
    kind && { label: `${kind} pairs at ${setup.score}/6`, match: (t) => tradeKind(t) === kind && t.score === setup.score },
    { label: `all pairs at ${setup.score}/6`, match: (t) => t.score === setup.score },
    { label: 'all setups', match: () => true },
  ].filter(Boolean);

  let largest = 0;
  for (const cohort of cohorts) {
    const group = filled.filter(cohort.match);
    largest = Math.max(largest, group.length);
    if (group.length < minSamples) continue;
    const s = summarize(group);
    const grade = s.expectancyLower > 0 ? 'high' : s.expectancyUpper < 0 ? 'low' : 'neutral';
    return {
      grade,
      cohort: cohort.label,
      n: s.n,
      winRate: round(s.winRate),
      expectancy: round(s.expectancy),
      expectancyLower: round(s.expectancyLower),
      expectancyUpper: round(s.expectancyUpper),
      live: group.filter((t) => t.source && t.source !== 'backtest').length,
    };
  }
  return { grade: 'unknown', cohort: null, n: largest, needed: minSamples };
}

/** Telegram lines for a rating. */
function describeRating(rating) {
  if (!rating) return [];
  const g = GRADES[rating.grade] || GRADES.unknown;
  if (rating.grade === 'unknown') {
    return [
      `${g.icon} <b>${g.label}</b>`,
      `<i>${rating.n} similar trade(s) resolved so far — ${rating.needed} needed before the bot will judge.</i>`,
    ];
  }
  const sign = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}R`;
  const src = rating.live ? `${rating.live} live, ${rating.n - rating.live} backtest` : 'backtest only';
  return [
    `${g.icon} <b>${g.label}</b>`,
    `<i>${rating.cohort}: ${rating.n} trades (${src}) · won ${Math.round(rating.winRate * 100)}% · ` +
      `average ${sign(rating.expectancy)} (95% range ${sign(rating.expectancyLower)} to ${sign(rating.expectancyUpper)})</i>`,
  ];
}

const round = (n) => Number(n.toFixed(4));

module.exports = { rateSetup, describeRating, GRADES };
