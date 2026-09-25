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
    this.lastCandles = new Map();
    // Current 4H bias per instrument, so open setups can be cancelled on a flip.
    this.lastBias = new Map();
    this.opts = opts.engineOpts || {};
    this.persist = opts.persist !== undefined ? opts.persist : config.db.enabled;
    this.edgeProfile =
      opts.edgeProfile ||
      EdgeProfile.load(config.edge.profilePath, {
        required: config.edge.required,
        enforceUnvalidated: config.edge.enforceUnvalidated,
      });
    this.shadowLogging = opts.shadowLogging !== undefined ? opts.shadowLogging : config.learn.shadowLogging;
    this.learning = opts.learning || null;
    // Per-pair on/off and pause, set from Telegram (src/control).
    this.settings = opts.settings || null;
    // Anything with rate(setup) -> rating; normally the LearningService.
    this.rater = opts.rater || null;
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

    // Let the market answer whatever it has answered, then grow if there is
    // enough new evidence to be worth re-learning from.
    if (this.learning) {
      for (const instrument of this.instruments) {
        const candles = this.lastCandles.get(instrument.id);
        if (!candles) continue;
        const bias = this.lastBias.get(instrument.id) || null;
        await this.learning.resolve(instrument, candles, now / 1000, { bias }).catch((err) => {
          log.error(`${instrument.id} outcome resolution failed: ${err.message}`);
        });
      }
      await this.learning.relearn().catch((err) => log.error(`relearn failed: ${err.message}`));
      if (this.learning.profile) this.edgeProfile = this.learning.profile;
    }

    const fired = results.filter((r) => r.fired).length;
    const shadowed = results.filter((r) => r.shadowed).length;
    log.info(
      `scan complete — ${fired} alert(s), ${shadowed} held back and tracked, from ${results.length} instrument(s)`
    );
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

    this.lastCandles.set(instrument.id, ltf);

    // Learned stop/target placement for this market, when one was validated.
    const planAdjust = this.edgeProfile.planFor ? this.edgeProfile.planFor(instrument.id) : null;
    const evaluation = evaluateSetup({ instrument, htf, ltf, engineOpts, rates, planAdjust });
    this.lastBias.set(instrument.id, evaluation.bias || null);
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

    const fingerprint = {
      instrumentId: instrument.id,
      direction: bias.direction,
      poiId: scoring.entryPoi ? scoring.entryPoi.id : null,
      entryPrice: plan.entryPrice,
      riskDistance: plan.riskDistance,
    };

    // ---- 4. De-duplication, before the edge gate ----
    // Checked here rather than inside delivery so an alerted setup and a
    // shadow-logged one are suppressed on the same terms, which keeps the live
    // record directly comparable with the backtest.
    if (this.alerts.isDuplicate(fingerprint, now)) {
      return { instrumentId: instrument.id, fired: false, stage: 'dedup', reason: 'Duplicate of a recent setup', bias, scoring, plan };
    }

    const alert = buildSetupRecord({ instrument, evaluation, ltf });

    // ---- 5. Learned edge profile ----
    // The gates above say the setup is structurally valid. This says whether
    // setups like it have actually paid, which is a different question.
    const verdict = this.edgeProfile.evaluate({
      instrumentId: instrument.id,
      direction: bias.direction,
      score: scoring.score,
      confirmations: scoring.fired.map((c) => c.id),
      features: evaluation.features || [],
      biasStrength: bias.strength,
    });
    alert.edgeProfile = { matched: verdict.allow, reason: verdict.reason, active: this.edgeProfile.active };
    if (this.rater) {
      try {
        alert.rating = this.rater.rate({
          instrumentId: instrument.id,
          instrumentKind: instrument.kind,
          direction: bias.direction,
          score: scoring.score,
        });
      } catch (err) {
        log.warn(`${instrument.id} could not be rated: ${err.message}`);
      }
    }

    // ---- Per-pair playbook ----
    // A combination proven on THIS pair outranks the all-pairs filter; in
    // playbook-only mode, a pair with a proven playbook sends nothing else.
    const pb = this.edgeProfile.playbookMatch
      ? this.edgeProfile.playbookMatch(instrument.id, evaluation.features || [])
      : { hasProven: false, matches: [] };
    const provenMatch = pb.matches.find((m) => m.status === 'proven') || null;
    if (pb.matches.length) alert.playbook = { matches: pb.matches.slice(0, 2), baseline: pb.baseline };
    const allowed = verdict.allow || Boolean(provenMatch);
    if (!verdict.allow && provenMatch) {
      alert.edgeProfile = {
        matched: true,
        active: this.edgeProfile.active,
        reason: `Sent on ${instrument.id}'s proven playbook although the all-pairs filter would hold it (${verdict.reason})`,
      };
    }
    const offPlaybook = allowed && this.settings && this.settings.playbookOnly && pb.hasProven && !provenMatch;

    // A pair switched off (or alerts paused) from Telegram takes the same
    // path as a held-back setup: tracked and learned from, just not sent.
    const muted = allowed && this.settings && !this.settings.shouldAlert(instrument.id);

    if (!allowed || muted || offPlaybook) {
      // Held back from the user, but still tracked and learned from. Without
      // this the bot would only ever see outcomes for trades it already
      // believed in, and the filter could never discover it was wrong.
      this.alerts.reserve(fingerprint, now);
      let shadowId = null;
      if (this.persist && this.shadowLogging) {
        const record = await this.db
          .logAlert(alert, { delivered: false, shadow: true })
          .catch((err) => {
            log.error(`failed to shadow-log setup: ${err.message}`);
            return null;
          });
        shadowId = record ? String(record._id) : null;
      }
      const reason = muted
        ? this.settings.paused
          ? 'Alerts paused from Telegram'
          : 'Pair switched off from Telegram'
        : offPlaybook
          ? `Does not match ${instrument.id}'s proven playbook (playbook-only mode)`
          : verdict.reason;
      log.debug(`${instrument.id} held back: ${reason}`);
      return {
        instrumentId: instrument.id,
        fired: false,
        shadowed: true,
        stage: muted ? 'muted' : offPlaybook ? 'playbook' : 'gate:edge',
        reason,
        recordId: shadowId,
        alert,
        bias,
        scoring,
        plan,
      };
    }

    // ---- 6. Delivery + logging ----
    const delivery = await this.alerts.deliver(alert, now);

    let record = null;
    if (delivery.messageId) alert.telegramMessageId = delivery.messageId;
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
   * Read from the same feed the cross pair itself uses, so it works whichever
   * forex source is configured. Falls back to the configured static rates when
   * the lookup fails.
   */
  async fetchRates() {
    const rates = {};
    const crosses = this.instruments.filter(
      (i) => i.kind === 'forex' && i.quoteCurrency !== 'USD' && i.baseCurrency !== 'USD'
    );

    for (const cross of crosses) {
      const ccy = cross.quoteCurrency;
      if (rates[ccy]) continue;
      const symbol = usdPairSymbol(cross.source, ccy);
      if (!symbol) continue;

      try {
        const connector = this.data.connectorFor({ id: `USD${ccy}`, source: cross.source });
        if (connector.configured === false) continue;
        const candles = await connector.fetchCandles(symbol, 60, 3);
        const last = candles[candles.length - 1];
        if (last && last.close > 0) rates[ccy] = 1 / last.close;
      } catch (err) {
        log.debug(`no live USD/${ccy} rate from ${cross.source}: ${err.message}`);
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
/** The USD/<ccy> symbol on a given feed, following each feed's naming. */
function usdPairSymbol(source, ccy) {
  if (source === 'deriv') return `frxUSD${ccy}`;
  if (source === 'oanda') return `USD_${ccy}`;
  return null;
}

function mergeEngineOpts(base = {}, override = {}) {
  if (!override) return { ...base };
  const out = { ...base };
  for (const [section, value] of Object.entries(override)) {
    const isPlainObject = value && typeof value === 'object' && !Array.isArray(value);
    out[section] = isPlainObject ? mergeEngineOpts(base[section] || {}, value) : value;
  }
  return out;
}

module.exports = { Scanner, mergeEngineOpts, usdPairSymbol };
