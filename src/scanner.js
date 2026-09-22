'use strict';

const config = require('./config');
const { MarketDataService } = require('./data');
const { evaluateSetup, buildSetupRecord } = require('./evaluate');
const { AlertService } = require('./alerts');
const { EdgeProfile } = require('./backtest/edgeProfile');
const db = require('./db');
const { createLogger } = require('./util/logger');
const { formatAlertLine } = require('./alerts/format');

const log = createLogger('scanner');

/**
 * One scan pass over every configured instrument.
 *
 * Pipeline per instrument:
 *   4H candles -> HTF bias
 *   30m candles -> confirmation score (needs 3 of 6)
 *   -> trade plan (hard 1:2 R:R gate)
 *   -> de-duplicated Telegram alert
 *   -> MongoDB record
 *
 * Every stage returns a reason when it stops, so a quiet scan is explainable.
 */
class Scanner {
  constructor(opts = {}) {
    this.data = opts.data || new MarketDataService();
    this.alerts = opts.alerts || new AlertService();
    this.db = opts.db || db;
    this.instruments = opts.instruments || config.instruments;
    this.opts = opts.engineOpts || {};
    this.persist = opts.persist !== undefined ? opts.persist : config.db.enabled;
    this.edgeProfile =
      opts.edgeProfile ||
      EdgeProfile.load(config.edge.profilePath, {
        required: config.edge.required,
        enforceUnvalidated: config.edge.enforceUnvalidated,
      });
  }

  async scanAll(now = Date.now()) {
    const results = [];
    const rates = await this.fetchRates().catch((err) => {
      log.warn(`could not build live FX rates: ${err.message}`);
      return {};
    });

    for (const instrument of this.instruments) {
      try {
        results.push(await this.scanInstrument(instrument, { rates, now }));
      } catch (err) {
        log.error(`${instrument.id} scan failed: ${err.message}`);
        results.push({ instrumentId: instrument.id, fired: false, stage: 'error', reason: err.message });
      }
    }

    const fired = results.filter((r) => r.fired).length;
    log.info(`scan complete — ${fired} alert(s) from ${results.length} instrument(s)`);
    return results;
  }

  async scanInstrument(instrument, { rates = {}, now = Date.now() } = {}) {
    // Instruments whose price process needs different thresholds (the Jump
    // indices, for one) carry their own overrides on top of the global config.
    const engineOpts = mergeEngineOpts(this.opts, instrument.engine);

    const { htf, ltf } = await this.data.getBiasAndEntryCandles(instrument, {
      htfSeconds: config.timeframes.htfSeconds,
      ltfSeconds: config.timeframes.ltfSeconds,
      htfCount: config.timeframes.htfCandles,
      ltfCount: config.timeframes.ltfCandles,
    });

    const evaluation = evaluateSetup({ instrument, htf, ltf, engineOpts, rates });
    if (!evaluation.ok) {
      return {
        instrumentId: instrument.id,
        fired: false,
        stage: evaluation.stage,
        reason: evaluation.reason,
        bias: evaluation.bias,
        scoring: evaluation.scoring,
        plan: evaluation.plan,
      };
    }
    const { bias, scoring, plan } = evaluation;

    // ---- 4. Learned edge profile ----
    // The gates above say the setup is structurally valid. This says whether
    // setups like it have actually paid, which is a different question.
    const verdict = this.edgeProfile.evaluate({
      instrumentId: instrument.id,
      direction: bias.direction,
      score: scoring.score,
      confirmations: scoring.fired.map((c) => c.id),
      biasStrength: bias.strength,
    });
    if (!verdict.allow) {
      log.debug(`${instrument.id} filtered by edge profile: ${verdict.reason}`);
      return {
        instrumentId: instrument.id,
        fired: false,
        stage: 'gate:edge',
        reason: verdict.reason,
        bias,
        scoring,
        plan,
      };
    }

    // ---- 5. Delivery + logging ----
    const alert = buildSetupRecord({ instrument, evaluation, ltf });
    alert.edgeProfile = { matched: true, reason: verdict.reason, active: this.edgeProfile.active };

    const delivery = await this.alerts.deliver(alert, now);

    let record = null;
    if (this.persist && delivery.skipped !== 'duplicate') {
      record = await this.db.logAlert(alert, { delivered: delivery.sent }).catch((err) => {
        log.error(`failed to log alert: ${err.message}`);
        return null;
      });
    }

    if (delivery.skipped === 'duplicate') {
      return { instrumentId: instrument.id, fired: false, stage: 'dedup', reason: 'Duplicate of a recent alert', alert, bias, scoring, plan };
    }

    log.info(formatAlertLine(alert));
    return {
      instrumentId: instrument.id,
      fired: true,
      stage: 'alert',
      alert,
      bias,
      scoring,
      plan,
      delivery,
      recordId: record ? String(record._id) : null,
    };
  }

  /**
   * Live quote-currency rates for cross pairs (e.g. GBP/JPY needs JPY->USD).
   * Falls back to the configured rates when the source is unavailable.
   */
  async fetchRates() {
    const rates = {};
    const needed = new Set(
      this.instruments
        .filter((i) => i.quoteCurrency !== 'USD' && i.baseCurrency !== 'USD')
        .map((i) => i.quoteCurrency)
    );
    if (!needed.size || !this.data.oanda || !this.data.oanda.configured) return rates;

    for (const ccy of needed) {
      try {
        const price = await this.data.oanda.fetchLatestPrice(`USD_${ccy}`);
        if (Number.isFinite(price) && price > 0) rates[ccy] = 1 / price;
      } catch (err) {
        log.debug(`no live USD_${ccy} rate: ${err.message}`);
      }
    }
    return rates;
  }

  close() {
    this.data.close();
  }
}

/**
 * Merge per-instrument engine overrides over the global options, one level deep
 * so a instrument can override a single threshold without restating its section.
 */
function mergeEngineOpts(base = {}, override = {}) {
  if (!override) return { ...base };
  const out = { ...base };
  for (const [section, value] of Object.entries(override)) {
    const isPlainObject = value && typeof value === 'object' && !Array.isArray(value);
    out[section] = isPlainObject ? mergeEngineOpts(base[section] || {}, value) : value;
  }
  return out;
}

module.exports = { Scanner, mergeEngineOpts };
