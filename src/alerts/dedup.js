'use strict';

const config = require('../config');

/**
 * Alert de-duplication.
 *
 * The same POI keeps producing the same setup on every 30m close until price
 * finally leaves it, so an alert is suppressed when a recent one matches
 * either:
 *   - the same instrument + direction + POI id, or
 *   - the same instrument + direction at an entry within `priceTolerance` of
 *     the stop distance (the same setup re-detected through a slightly
 *     different zone).
 *
 * Entries expire after `ttlMinutes`, so a setup that reappears much later is
 * treated as new.
 */
class AlertDeduplicator {
  constructor(opts = {}) {
    this.cfg = { ...config.alerts.dedup, ...opts };
    this.entries = [];
  }

  static keyFor(alert) {
    const poiId = (alert.plan && alert.plan.poiId) || alert.poiId || 'no-poi';
    return `${alert.instrumentId}:${alert.direction}:${poiId}`;
  }

  /** Load previously sent alerts (e.g. from Mongo after a restart). */
  seed(entries = []) {
    for (const e of entries) {
      if (!e || !Number.isFinite(e.timestamp)) continue;
      this.entries.push({ ...e });
    }
    this._prune(Date.now());
    return this;
  }

  /** Is this alert a repeat of one already sent? */
  isDuplicate(alert, now = Date.now()) {
    return this.findDuplicate(alert, now) !== null;
  }

  findDuplicate(alert, now = Date.now()) {
    this._prune(now);
    const key = AlertDeduplicator.keyFor(alert);
    const tolerance = this.cfg.priceTolerance * (alert.riskDistance || 0);

    for (const e of this.entries) {
      if (e.instrumentId !== alert.instrumentId) continue;
      if (e.direction !== alert.direction) continue;
      if (e.key === key) return e;
      if (tolerance > 0 && Math.abs(e.entryPrice - alert.entryPrice) <= tolerance) return e;
    }
    return null;
  }

  /** Record an alert as sent. */
  record(alert, now = Date.now()) {
    const entry = {
      key: AlertDeduplicator.keyFor(alert),
      instrumentId: alert.instrumentId,
      direction: alert.direction,
      entryPrice: alert.entryPrice,
      riskDistance: alert.riskDistance,
      timestamp: now,
    };
    this.entries.push(entry);
    this._prune(now);
    return entry;
  }

  _prune(now) {
    const cutoff = now - this.cfg.ttlMinutes * 60 * 1000;
    this.entries = this.entries.filter((e) => e.timestamp > cutoff);
    if (this.entries.length > this.cfg.maxEntries) {
      this.entries = this.entries.slice(this.entries.length - this.cfg.maxEntries);
    }
  }

  get size() {
    return this.entries.length;
  }

  clear() {
    this.entries = [];
  }
}

module.exports = { AlertDeduplicator };
