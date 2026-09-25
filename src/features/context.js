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
function extractContext({ instrument, bias, scoring, plan, ltfCandles, htfCandles = null }) {
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

  // ---- where price sits, and how it got there ----
  const bullish = bias.direction === 'bullish';
  if (htfCandles && htfCandles.length >= 20) tokens.push(`htf_zone:${htfZone(htfCandles, last.close)}`);
  if (plan && short > 0) tokens.push(`entry_dist:${bucketEntryDistance(Math.abs(last.close - plan.entryPrice) / short)}`);
  const prevDay = previousDayLevels(ltfCandles);
  if (prevDay) tokens.push(`prev_day:${prevDay}`);
  if (short > 0 && ltfCandles.length > 12) {
    const move = (last.close - ltfCandles[ltfCandles.length - 13].close) / short;
    const withTrade = bullish ? move : -move;
    tokens.push(`momentum:${withTrade > 2 ? 'with' : withTrade < -2 ? 'against' : 'flat'}`);
  }

  // Each confirmation that fired is itself a candidate feature.
  for (const c of scoring.fired) tokens.push(`confirm:${c.id}`);

  return tokens;
}

/** Price in the 4H dealing range of the last 50 bars: premium / discount / equilibrium. */
function htfZone(htf, price) {
  const recent = htf.slice(-50);
  const hi = Math.max(...recent.map((c) => c.high));
  const lo = Math.min(...recent.map((c) => c.low));
  if (!(hi > lo)) return 'equilibrium';
  const pos = (price - lo) / (hi - lo);
  return pos > 0.6 ? 'premium' : pos < 0.4 ? 'discount' : 'equilibrium';
}

const bucketEntryDistance = (atrs) => (atrs < 0.5 ? 'at' : atrs < 1.5 ? 'near' : 'far');

/**
 * Did today's candles (UTC) trade beyond yesterday's high or low?
 * took_high / took_low / took_both / inside, or null without a full prior day.
 */
function previousDayLevels(candles) {
  const last = candles[candles.length - 1];
  const today = Math.floor(last.time / 86400);
  const yesterday = candles.filter((c) => Math.floor(c.time / 86400) === today - 1);
  if (yesterday.length < 24) return null;
  const hi = Math.max(...yesterday.map((c) => c.high));
  const lo = Math.min(...yesterday.map((c) => c.low));
  const todays = candles.filter((c) => Math.floor(c.time / 86400) === today);
  const tookHigh = todays.some((c) => c.high > hi);
  const tookLow = todays.some((c) => c.low < lo);
  return tookHigh && tookLow ? 'took_both' : tookHigh ? 'took_high' : tookLow ? 'took_low' : 'inside';
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

module.exports = { extractContext, bucketHour, session, volRegime, bucketRr, bucketStop, htfZone, previousDayLevels };
