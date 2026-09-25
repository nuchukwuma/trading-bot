'use strict';

const { simulateTrade, SIMULATOR_DEFAULTS } = require('../backtest/simulator');
const { createLogger } = require('../util/logger');

const log = createLogger('learn:outcomes');

/**
 * Resolve the bot's own alerts against the candles that followed them.
 *
 * This is what turns the bot from something that reports into something that
 * learns: every setup it logged — alerted or shadow — gets an outcome once the
 * market has answered, and those outcomes are what the learner trains on.
 *
 * A setup stays PENDING until the market actually resolves it or the review
 * window closes. Marking a still-open trade as a loss would poison the sample.
 */
async function resolvePending({ db, instrument, candles, opts = {}, now = Date.now() / 1000, onEvent = null }) {
  const maxBars = opts.maxBars || 96;
  const barSeconds = opts.barSeconds || 1800;
  const fillBars = (opts.simulator && opts.simulator.maxBarsToFill) || SIMULATOR_DEFAULTS.maxBarsToFill;
  // How many windows of clock time without a full set of candles before the
  // feed is treated as dead. Generous, so a long weekend never trips it.
  const staleFactor = opts.staleFactor || 4;
  const emit = async (doc, event) => {
    if (!onEvent) return;
    try {
      await onEvent(doc, event);
    } catch (err) {
      log.warn(`trade update for ${doc._id} failed: ${err.message}`);
    }
  };

  const pending = await db.pendingAlerts(instrument.id);
  if (!pending.length) return { checked: 0, resolved: 0, stillOpen: 0 };

  let resolved = 0;
  let stillOpen = 0;

  for (const doc of pending) {
    const signalTime = Math.floor(new Date(doc.candleTime).getTime() / 1000);
    const forward = candles.filter((c) => c.time > signalTime);

    // The review window is counted in CANDLES, not clock time. Forex closes for
    // the weekend: judging a Friday setup on clock time would resolve it on
    // Monday after 48 hours but only a handful of real candles.
    const windowFull = forward.length >= maxBars;
    // Clock time is only a backstop for a feed that has stopped entirely.
    const feedDead = now - signalTime >= maxBars * barSeconds * staleFactor;

    if (forward.length === 0 && !feedDead) {
      stillOpen += 1;
      continue;
    }
    if (forward.length === 0) {
      log.warn(`alert ${doc._id}: no candles since the signal after ${staleFactor}x the window — leaving it for review`);
      continue;
    }

    const plan = toPlan(doc);
    if (!plan) {
      log.warn(`alert ${doc._id} has no usable trade plan — skipping`);
      continue;
    }

    const outcome = simulateTrade({
      plan,
      candles: forward,
      signalClose: Number.isFinite(doc.price) ? doc.price : plan.entryPrice,
      opts: { maxBars, ...opts.simulator },
    });

    // Still open when the simulator only stopped because the candles ran out:
    //  - a limit entry whose fill window has not passed yet (the simulator
    //    reports that as "expired", which it is not — yet)
    //  - a filled trade whose remainder was marked to the last close, even
    //    if TP1 or TP2 already paid
    const awaitingFill = !outcome.filled && forward.length < fillBars;
    const ranOut = outcome.filled && outcome.exits.some((e) => e.reason === 'timeout');
    if ((awaitingFill || (ranOut && !windowFull)) && !feedDead) {
      stillOpen += 1;
      const progress = progressOf(outcome, forward);
      const before = doc.progress || { filled: false, targetsHit: [] };
      if (progress.filled && !before.filled) await emit(doc, { type: 'filled', progress });
      for (const name of progress.targetsHit) {
        if (!(before.targetsHit || []).includes(name)) await emit(doc, { type: 'target', name, progress });
      }
      if (db.updateProgress) await db.updateProgress(doc._id, progress).catch(() => {});
      continue;
    }

    const record = {
      status: outcome.status,
      rMultiple: outcome.rMultiple,
      barsHeld: outcome.barsHeld,
      mfe: outcome.mfe,
      mae: outcome.mae,
      resolvedBy: 'simulator',
    };
    await db.recordOutcome(doc._id, record);
    resolved += 1;
    await emit(doc, { type: 'closed', outcome: { ...record, exits: outcome.exits, filled: outcome.filled } });
  }

  if (resolved) log.info(`${instrument.id}: resolved ${resolved} setup(s), ${stillOpen} still open`);
  return { checked: pending.length, resolved, stillOpen };
}

/** Where an open trade stands: filled or not, targets paid, R marked to the last close. */
function progressOf(outcome, candles) {
  const last = candles[candles.length - 1];
  return {
    filled: Boolean(outcome.filled),
    targetsHit: (outcome.exits || []).map((e) => e.reason).filter((r) => /^TP\d$/.test(r)),
    currentR: outcome.filled ? outcome.rMultiple : 0,
    lastPrice: last ? last.close : null,
    barsSinceSignal: candles.length,
    updatedAt: new Date(),
  };
}

/** Rebuild the plan shape the simulator needs from a persisted document. */
function toPlan(doc) {
  const p = doc.tradePlan;
  if (!p || !Number.isFinite(p.entryPrice) || !Number.isFinite(p.stopPrice) || !(p.riskDistance > 0)) return null;
  if (!Array.isArray(p.targets) || !p.targets.length) return null;

  return {
    direction: doc.direction,
    entryPrice: p.entryPrice,
    stopPrice: p.stopPrice,
    riskDistance: p.riskDistance,
    targets: p.targets.map((t) => ({
      name: t.name,
      price: t.price,
      closePct: t.closePct,
      moveStopToBreakeven: t.moveStopToBreakeven,
      trailToStructure: t.trailToStructure,
    })),
  };
}

module.exports = { resolvePending, toPlan, progressOf };
