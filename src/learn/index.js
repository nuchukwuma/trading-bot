'use strict';

const config = require('../config');
const { learn } = require('./learner');
const { resolvePending, recordVariants } = require('./outcomeTracker');
const { rateSetup } = require('./rater');
const ledger = require('./ledger');
const { loadProfile, saveProfile } = require('./profileStore');
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
    // Called with (alertDocument, event) as a trade fills, pays a target, or
    // plays out — the scanner's owner turns these into Telegram messages.
    this.onTradeEvent = opts.onTradeEvent || null;
    this.kindOf = opts.kindOf || (() => null);
    this.trades = [];
    this.ledgerStale = true;
    // The current learned profile, kept in MongoDB (profileStore.js).
    this.profile = null;
  }

  /** Backtest seed + every resolved live setup, merged and de-duplicated. */
  async loadProfile() {
    this.profile = await loadProfile({ db: this.db, filePath: this.profilePath });
    return this.profile;
  }

  async loadLedger() {
    // Backtest seed from MongoDB (survives restarts), else the local file.
    const stored = this.db.loadBacktestTrades ? await this.db.loadBacktestTrades().catch(() => null) : null;
    const seed = stored && stored.length ? stored : ledger.loadBacktestTrades(this.seedPath);
    const live = (await this.db.resolvedAlerts({ limit: this.cfg.maxLedgerTrades })).map(ledger.fromAlertDocument);
    this.trades = ledger.mergeLedger(seed, live);
    this.ledgerStale = false;
    return this.trades;
  }

  /** How setups like this one have done so far. See rater.js. */
  rate(setup) {
    return rateSetup(this.trades, setup, { minSamples: this.cfg.minSamples, kindOf: this.kindOf });
  }

  /** Resolve outcomes for one instrument using candles already in hand. */
  async resolve(instrument, candles, now, { bias = null } = {}) {
    const result = await resolvePending({
      db: this.db,
      instrument,
      candles,
      opts: { maxBars: this.cfg.maxBars, barSeconds: config.timeframes.ltfSeconds },
      now,
      onEvent: this.onTradeEvent,
      currentBias: bias,
    });
    this.resolvedSinceLearn += result.resolved;
    if (result.resolved) this.ledgerStale = true;
    const replayed = await recordVariants({
      db: this.db,
      instrument,
      candles,
      opts: { maxBars: this.cfg.maxBars, barSeconds: config.timeframes.ltfSeconds },
      now,
    }).catch(() => 0);
    if (replayed) this.ledgerStale = true;
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
    // Ratings use the latest outcomes even between re-learns.
    if (this.ledgerStale) await this.loadLedger();
    if (!force && !this.dueForRelearn) return null;

    const trades = await this.loadLedger();
    const summary = ledger.ledgerSummary(trades);

    if (!trades.length) {
      log.info('nothing in the ledger yet — keeping the current profile');
      this.resolvedSinceLearn = 0;
      return null;
    }

    const result = learn(trades, this.cfg);
    const previous = this.profile || (await this.loadProfile());

    this.profile = await saveProfile({
      db: this.db,
      filePath: this.profilePath,
      result: { ...result, meta: { ledger: summary, growth: result.growth, learnedAt: new Date().toISOString() } },
    });

    this.resolvedSinceLearn = 0;

    const changed =
      JSON.stringify(previous.rules) !== JSON.stringify(result.rules) ||
      JSON.stringify((previous.data && previous.data.plan && previous.data.plan.byGroup) || {}) !==
        JSON.stringify(result.plan.byGroup);
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
