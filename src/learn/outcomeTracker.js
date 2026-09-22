'use strict';

const { simulateTrade } = require('../backtest/simulator');
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
async function resolvePending({ db, instrument, candles, opts = {}, now = Date.now() / 1000 }) {
  const maxBars = opts.maxBars || 96;
  const barSeconds = opts.barSeconds || 1800;

  const pending = await db.pendingAlerts(instrument.id);
  if (!pending.length) return { checked: 0, resolved: 0, stillOpen: 0 };

  let resolved = 0;
  let stillOpen = 0;

  for (const doc of pending) {
    const signalTime = Math.floor(new Date(doc.candleTime).getTime() / 1000);
    const forward = candles.filter((c) => c.time > signalTime);

    // Not enough history yet to say anything. Leave it alone.
    const windowClosed = now - signalTime >= maxBars * barSeconds;
    if (forward.length === 0 || (!windowClosed && forward.length < maxBars)) {
      stillOpen += 1;
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

    // Still running and the window has not closed: check again next scan.
    if (outcome.status === 'timeout' && !windowClosed) {
      stillOpen += 1;
      continue;
    }

    await db.recordOutcome(doc._id, {
      status: outcome.status,
      rMultiple: outcome.rMultiple,
      barsHeld: outcome.barsHeld,
      mfe: outcome.mfe,
      mae: outcome.mae,
      resolvedBy: 'simulator',
    });
    resolved += 1;
  }

  if (resolved) log.info(`${instrument.id}: resolved ${resolved} setup(s), ${stillOpen} still open`);
  return { checked: pending.length, resolved, stillOpen };
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

module.exports = { resolvePending, toPlan };
