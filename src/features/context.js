'use strict';

const { averageRange } = require('../util/candles');

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * Contextual features of a setup — when it happened, what state the market was
 * in, and the shape of the plan itself.
 *
 * Like the chart patterns, these are candidates only. Bucketing is deliberately
 * coarse: fine-grained buckets shatter the sample and invent patterns that do
 * not survive a holdout.
 */
function extractContext({ instrument, bias, scoring, plan, ltfCandles }) {
  const tokens = [];
  const last = ltfCandles[ltfCandles.length - 1];
  const date = new Date(last.time * 1000);

  // ---- when ----
  const hour = date.getUTCHours();
  tokens.push(`hour:${bucketHour(hour)}`);
  tokens.push(`dow:${DAYS[date.getUTCDay()]}`);
  tokens.push(`session:${session(hour)}`);

  // ---- market state ----
  const short = averageRange(ltfCandles, 20);
  const long = averageRange(ltfCandles, 100);
  tokens.push(`vol:${volRegime(short, long)}`);

  // ---- the setup ----
  tokens.push(`dir:${bias.direction}`);
  tokens.push(`bias:${bias.strength}`);
  tokens.push(`score:${scoring.score}`);
  tokens.push(`instrument:${instrument.id}`);
  if (instrument.subKind) tokens.push(`kind:${instrument.subKind}`);

  const event = scoring.ltfStructure && scoring.ltfStructure.lastEvent;
  if (event) tokens.push(`shift:${event.type.toLowerCase()}`);

  if (scoring.entryPoi) tokens.push(`poi:${scoring.entryPoi.kind.toLowerCase()}`);

  const sweep = sweepOf(scoring);
  tokens.push(`sweep:${sweep}`);

  // ---- the plan ----
  if (plan) {
    tokens.push(`rr:${bucketRr(plan.riskReward)}`);
    tokens.push(`capped:${plan.targets.some((t) => t.cappedBy) ? 'yes' : 'no'}`);
    if (short > 0) tokens.push(`stop:${bucketStop(plan.riskDistance / short)}`);
  }

  // Each confirmation that fired is itself a candidate feature.
  for (const c of scoring.fired) tokens.push(`confirm:${c.id}`);

  return tokens;
}

const bucketHour = (h) => {
  if (h < 4) return '00-04';
  if (h < 8) return '04-08';
  if (h < 12) return '08-12';
  if (h < 16) return '12-16';
  if (h < 20) return '16-20';
  return '20-24';
};

/**
 * Rough UTC trading sessions. The bot does not restrict scanning by session —
 * this exists so the learner can find out whether it should.
 */
const session = (h) => {
  if (h >= 0 && h < 7) return 'asia';
  if (h >= 7 && h < 12) return 'london';
  if (h >= 12 && h < 16) return 'london_ny';
  if (h >= 16 && h < 21) return 'ny';
  return 'off';
};

function volRegime(short, long) {
  if (!(long > 0)) return 'unknown';
  const ratio = short / long;
  if (ratio < 0.8) return 'low';
  if (ratio > 1.25) return 'high';
  return 'normal';
}

function sweepOf(scoring) {
  const check = scoring.confirmations.find((c) => c.id === 'liquidity_sweep');
  if (!check || !check.passed || !check.details || !check.details.sweep) return 'none';
  return check.details.sweep.type.toLowerCase();
}

const bucketRr = (rr) => (rr < 2.5 ? '2.0-2.5' : rr < 3.5 ? '2.5-3.5' : rr < 5 ? '3.5-5.0' : '5.0+');

const bucketStop = (atrMultiple) =>
  atrMultiple < 1 ? 'tight' : atrMultiple < 2.5 ? 'normal' : atrMultiple < 5 ? 'wide' : 'very_wide';

module.exports = { extractContext, bucketHour, session, volRegime, bucketRr, bucketStop };
