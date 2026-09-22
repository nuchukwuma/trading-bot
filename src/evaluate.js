'use strict';

const config = require('./config');
const { computeBias } = require('./structure/bias');
const { scoreSetup } = require('./scoring');
const { buildTradePlan } = require('./tradeplan');

/**
 * Evaluate one instrument at one moment in time.
 *
 * This is the single decision path: the live scanner calls it on each 30m
 * close, and the backtester calls it once per historical bar. Neither has its
 * own copy of the logic, so a backtest result can never drift from what the
 * bot would actually have alerted.
 *
 * `htf` and `ltf` must contain only CLOSED candles at or before the moment
 * being evaluated — the backtester slices them, the live feed drops the
 * forming candle.
 *
 * @returns {{ ok: boolean, stage: string, reason?: string, bias, scoring, plan }}
 */
function evaluateSetup({ instrument, htf, ltf, engineOpts = {}, rates = {} }) {
  if (!htf || !ltf || !htf.length || !ltf.length) {
    return { ok: false, stage: 'data', reason: 'No candles available' };
  }

  // ---- 1. HTF bias ----
  const bias = computeBias(htf, {
    instrument,
    timeframe: config.timeframes.htf,
    structureOpts: engineOpts.structure,
    poi: engineOpts.poi,
  });
  if (bias.direction === 'neutral') {
    return { ok: false, stage: 'bias', reason: bias.reasons[0], bias };
  }

  // ---- 2. 30m confirmations ----
  const scoring = scoreSetup({ instrument, bias, ltfCandles: ltf, opts: engineOpts });
  if (!scoring.passed) {
    return {
      ok: false,
      stage: 'confirmations',
      reason: `${scoring.score}/${scoring.total} confirmations, ${scoring.required} required`,
      bias,
      scoring,
    };
  }

  // ---- 3. Trade plan + hard R:R gate ----
  const sweepCheck = scoring.confirmations.find((c) => c.id === 'liquidity_sweep');
  const plan = buildTradePlan({
    instrument,
    direction: bias.direction,
    entryPrice: scoring.entryPrice,
    poi: scoring.entryPoi,
    sweep: sweepCheck && sweepCheck.details ? sweepCheck.details.sweep : null,
    swings: scoring.ltfStructure.swings,
    candles: ltf,
    // Only HTF zones count as overhead resistance. An opposing 30m POI is
    // usually created BY the retrace into our entry, and price filling it on
    // the way back out is the setup working, not an obstacle to it.
    opposingPois: bias.pois || [],
    rates,
    opts: engineOpts.tradePlan,
  });

  if (!plan.valid) {
    return { ok: false, stage: `gate:${plan.gate}`, reason: plan.reason, bias, scoring, plan };
  }

  return { ok: true, stage: 'setup', bias, scoring, plan };
}

/** The shape both the alert formatter and the backtest recorder consume. */
function buildSetupRecord({ instrument, evaluation, ltf }) {
  const { bias, scoring, plan } = evaluation;
  return {
    instrument,
    direction: bias.direction,
    bias,
    score: scoring.score,
    required: scoring.required,
    total: scoring.total,
    confirmations: scoring.fired,
    allConfirmations: scoring.confirmations,
    plan,
    price: scoring.price,
    candleTime: ltf[ltf.length - 1].time,
    poiId: scoring.entryPoi ? scoring.entryPoi.id : null,
  };
}

module.exports = { evaluateSetup, buildSetupRecord };
