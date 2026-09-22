'use strict';

const config = require('../config');
const { evaluateSetup } = require('../evaluate');
const { simulateTrade } = require('./simulator');
const { AlertDeduplicator } = require('../alerts/dedup');
const { mergeEngineOpts } = require('../scanner');

const DEFAULTS = {
  // Bars of history the engines need before the first evaluation is meaningful.
  warmupBars: 120,
  // Leave enough forward candles for a trade to resolve, so the tail of the
  // series does not fill the sample with artificial timeouts.
  tailBars: 96,
  applyDedup: true,
};

/**
 * Walk-forward replay of one instrument.
 *
 * For each historical 30m close, the engines are handed ONLY the candles that
 * had closed by that moment, then the resulting plan is traded forward against
 * the candles that came next. Nothing downstream of the slice can see the
 * future.
 *
 * The same `evaluateSetup` the live scanner uses does the deciding, and the
 * same de-duplicator suppresses repeats, so the trade count here matches what
 * the bot would actually have sent.
 */
function replayInstrument({ instrument, htf, ltf, opts = {} }) {
  const cfg = { ...DEFAULTS, ...opts };
  const engineOpts = mergeEngineOpts(opts.engineOpts || {}, instrument.engine);
  const htfSeconds = config.timeframes.htfSeconds;
  const ltfSeconds = config.timeframes.ltfSeconds;

  const dedup = cfg.applyDedup ? new AlertDeduplicator(opts.dedupOpts || {}) : null;
  const trades = [];
  const skipped = { bias: 0, confirmations: 0, gate: 0, dedup: 0, data: 0 };

  const lastEvaluated = ltf.length - cfg.tailBars;

  for (let i = cfg.warmupBars; i < lastEvaluated; i += 1) {
    const ltfSlice = ltf.slice(0, i + 1);
    const barCloseTime = ltf[i].time + ltfSeconds;

    // Only 4H candles that had already CLOSED by this 30m close are visible.
    const htfSlice = htf.filter((c) => c.time + htfSeconds <= barCloseTime);
    if (!htfSlice.length) {
      skipped.data += 1;
      continue;
    }

    const evaluation = evaluateSetup({ instrument, htf: htfSlice, ltf: ltfSlice, engineOpts });
    if (!evaluation.ok) {
      const bucket = evaluation.stage.startsWith('gate:') ? 'gate' : evaluation.stage;
      if (skipped[bucket] !== undefined) skipped[bucket] += 1;
      continue;
    }

    const { bias, scoring, plan, features } = evaluation;

    // The live bot would not have sent a repeat, so the backtest must not
    // count one either.
    if (dedup) {
      const fingerprint = {
        instrumentId: instrument.id,
        direction: bias.direction,
        poiId: scoring.entryPoi ? scoring.entryPoi.id : null,
        entryPrice: plan.entryPrice,
        riskDistance: plan.riskDistance,
      };
      const barTimeMs = barCloseTime * 1000;
      if (dedup.findDuplicate(fingerprint, barTimeMs)) {
        skipped.dedup += 1;
        continue;
      }
      dedup.record(fingerprint, barTimeMs);
    }

    const outcome = simulateTrade({
      plan,
      candles: ltf.slice(i + 1),
      signalClose: ltf[i].close,
      opts: opts.simulator || {},
    });

    trades.push(
      buildTradeRecord({ instrument, bias, scoring, plan, outcome, features, barIndex: i, time: ltf[i].time })
    );
  }

  return { instrumentId: instrument.id, trades, skipped, evaluatedBars: Math.max(0, lastEvaluated - cfg.warmupBars) };
}

function buildTradeRecord({ instrument, bias, scoring, plan, outcome, features, barIndex, time }) {
  return {
    instrumentId: instrument.id,
    instrumentKind: instrument.kind,
    subKind: instrument.subKind || null,
    time,
    barIndex,

    direction: bias.direction,
    biasStrength: bias.strength,
    biasScore: bias.score,

    score: scoring.score,
    // Sorted so the same combination always produces the same signature.
    confirmations: scoring.fired.map((c) => c.id).sort(),
    confirmationSignature: scoring.fired.map((c) => c.id).sort().join('+'),
    // Chart patterns and context the learner searches over.
    features: features || [],

    entryPrice: plan.entryPrice,
    stopPrice: plan.stopPrice,
    riskDistance: plan.riskDistance,
    riskReward: plan.riskReward,
    poiKind: scoring.entryPoi ? scoring.entryPoi.kind : null,
    targetCapped: plan.targets.some((t) => t.cappedBy),

    filled: outcome.filled,
    status: outcome.status,
    rMultiple: outcome.rMultiple,
    barsHeld: outcome.barsHeld,
    mfe: outcome.mfe,
    mae: outcome.mae,
  };
}

/** Replay several instruments and pool the trades, newest last. */
function replayAll({ series, opts = {} }) {
  const runs = [];
  for (const { instrument, htf, ltf } of series) {
    runs.push(replayInstrument({ instrument, htf, ltf, opts }));
  }
  const trades = runs
    .flatMap((r) => r.trades)
    .sort((a, b) => a.time - b.time);
  return { runs, trades };
}

module.exports = { replayInstrument, replayAll, REPLAY_DEFAULTS: DEFAULTS };
