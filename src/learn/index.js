'use strict';

const config = require('../config');
const { learn } = require('./learner');
const { resolvePending } = require('./outcomeTracker');
const ledger = require('./ledger');
const { EdgeProfile } = require('../backtest/edgeProfile');
const { createLogger } = require('../util/logger');

const log = createLogger('learn');

/**
 * The growth loop.
 *
 * After each scan the bot resolves whatever the market has answered, and once
 * enough NEW outcomes have accumulated it re-runs the learner over the whole
 * ledger and rewrites the profile. Alerts narrow as the evidence arrives.
 */
class LearningService {
  constructor(opts = {}) {
    this.db = opts.db || require('../db');
    this.cfg = { ...config.learn, ...(opts.cfg || {}) };
    this.profilePath = opts.profilePath || config.edge.profilePath;
    this.seedPath = opts.seedPath || config.learn.seedPath;
    this.resolvedSinceLearn = 0;
    this.onProfileChange = opts.onProfileChange || (() => {});
  }

  /** Resolve outcomes for one instrument using candles already in hand. */
  async resolve(instrument, candles, now) {
    const result = await resolvePending({
      db: this.db,
      instrument,
      candles,
      opts: { maxBars: this.cfg.maxBars, barSeconds: config.timeframes.ltfSeconds },
      now,
    });
    this.resolvedSinceLearn += result.resolved;
    return result;
  }

  get dueForRelearn() {
    return this.resolvedSinceLearn >= this.cfg.relearnEvery;
  }

  /**
   * Re-run the learner over backtest seed + live outcomes and rewrite the
   * profile. Returns null when there was nothing new to learn from.
   */
  async relearn({ force = false } = {}) {
    if (!force && !this.dueForRelearn) return null;

    const seed = ledger.loadBacktestTrades(this.seedPath);
    const live = (await this.db.resolvedAlerts({ limit: this.cfg.maxLedgerTrades })).map(ledger.fromAlertDocument);
    const trades = ledger.mergeLedger(seed, live);
    const summary = ledger.ledgerSummary(trades);

    if (!trades.length) {
      log.info('nothing in the ledger yet — keeping the current profile');
      this.resolvedSinceLearn = 0;
      return null;
    }

    const result = learn(trades, this.cfg);
    const previous = EdgeProfile.load(this.profilePath);

    EdgeProfile.save(this.profilePath, {
      ...result,
      meta: { ledger: summary, growth: result.growth, learnedAt: new Date().toISOString() },
    });

    this.resolvedSinceLearn = 0;

    const changed = JSON.stringify(previous.rules) !== JSON.stringify(result.rules);
    log.info(
      `relearned on ${summary.total} trades (${JSON.stringify(summary.bySource)}) — ` +
        `${result.growth.featureRulesUsed}/${result.growth.featureRuleBudget} feature rules, ` +
        `validated: ${result.validated}${changed ? ', RULES CHANGED' : ''}`
    );
    for (const note of result.notes) log.info(`  ${note}`);

    if (changed) this.onProfileChange(result);
    return { result, summary, changed };
  }
}

module.exports = { LearningService, learn, resolvePending, ...ledger };
