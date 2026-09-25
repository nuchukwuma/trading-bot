'use strict';

const fs = require('fs');
const path = require('path');

/**
 * The trade ledger: everything the learner has ever seen.
 *
 * Two sources, in the same shape:
 *   - backtest trades, written once by `npm run backtest` as the seed
 *   - live setups the bot logged and later resolved from candles
 *
 * Live records include SHADOW setups — ones the profile held back. Learning
 * from only what was alerted would be a closed loop: the filter would never
 * discover it was wrong to exclude something.
 */

/** Map a persisted alert document onto the learner's trade shape. */
function fromAlertDocument(doc) {
  const plan = doc.tradePlan || {};
  const outcome = doc.outcome || {};
  return {
    source: doc.shadow ? 'live-shadow' : 'live',
    alertId: String(doc._id),
    instrumentId: doc.instrumentId,
    instrumentKind: doc.instrumentKind,
    time: Math.floor(new Date(doc.candleTime).getTime() / 1000),

    direction: doc.direction,
    biasStrength: doc.htfBias ? doc.htfBias.strength : null,
    biasScore: doc.htfBias ? doc.htfBias.score : null,

    score: doc.score,
    confirmations: (doc.confirmations || []).filter((c) => c.passed).map((c) => c.id).sort(),
    confirmationSignature: (doc.confirmations || [])
      .filter((c) => c.passed)
      .map((c) => c.id)
      .sort()
      .join('+'),
    features: doc.features || [],

    entryPrice: plan.entryPrice,
    stopPrice: plan.stopPrice,
    riskDistance: plan.riskDistance,
    riskReward: plan.riskReward,
    poiKind: doc.poiKind || null,
    targetCapped: (plan.targets || []).some((t) => t.cappedBy),

    filled: outcome.status !== 'expired',
    status: outcome.status,
    rMultiple: Number.isFinite(outcome.rMultiple) ? outcome.rMultiple : 0,
    barsHeld: outcome.barsHeld || 0,
    mfe: outcome.mfe || 0,
    mae: outcome.mae || 0,
    variants: doc.variants || null,
  };
}

function saveBacktestTrades(filePath, trades, meta = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({ version: 1, savedAt: new Date().toISOString(), meta, trades }, null, 0)}\n`
  );
  return trades.length;
}

function loadBacktestTrades(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return (data.trades || []).map((t) => ({ ...t, source: t.source || 'backtest' }));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return [];
  }
}

/**
 * Pool the sources into one chronological ledger. A live record supersedes a
 * backtest record for the same instrument and bar, so re-running the backtest
 * over a period the bot has since traded live cannot double-count it.
 */
function mergeLedger(backtestTrades = [], liveTrades = []) {
  const liveKeys = new Set(liveTrades.map((t) => `${t.instrumentId}:${t.time}`));
  const seed = backtestTrades.filter((t) => !liveKeys.has(`${t.instrumentId}:${t.time}`));

  const seen = new Set();
  return [...seed, ...liveTrades]
    .filter((t) => {
      const key = `${t.source === 'backtest' ? 'bt' : 'live'}:${t.instrumentId}:${t.time}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.time - b.time);
}

/** Counts per source, for the growth log. */
function ledgerSummary(trades) {
  const bySource = {};
  for (const t of trades) bySource[t.source || 'backtest'] = (bySource[t.source || 'backtest'] || 0) + 1;
  return { total: trades.length, bySource };
}

module.exports = { fromAlertDocument, saveBacktestTrades, loadBacktestTrades, mergeLedger, ledgerSummary };
