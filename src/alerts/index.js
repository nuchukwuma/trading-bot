'use strict';

const config = require('../config');
const { TelegramClient } = require('./telegram');
const { AlertDeduplicator } = require('./dedup');
const { formatAlert, formatAlertLine } = require('./format');
const { createLogger } = require('../util/logger');

const log = createLogger('alerts');

/**
 * Alert delivery: de-duplicate, format, send to Telegram, hand the record back
 * to the caller for logging.
 */
class AlertService {
  constructor(opts = {}) {
    this.telegram = opts.telegram || new TelegramClient(opts.telegramOpts || {});
    this.dedup = opts.dedup || new AlertDeduplicator(opts.dedupOpts || {});
    this.dryRun = opts.dryRun !== undefined ? opts.dryRun : config.dryRun;
  }

  /**
   * @returns {{ sent: boolean, skipped?: string, message?: string, duplicateOf?: object }}
   */
  async deliver(alert, now = Date.now()) {
    const fingerprint = {
      instrumentId: alert.instrument.id,
      direction: alert.direction,
      poiId: alert.poiId,
      entryPrice: alert.plan.entryPrice,
      riskDistance: alert.plan.riskDistance,
    };

    const duplicate = this.dedup.findDuplicate(fingerprint, now);
    if (duplicate) {
      log.debug(`suppressed duplicate ${fingerprint.instrumentId} ${fingerprint.direction}`);
      return { sent: false, skipped: 'duplicate', duplicateOf: duplicate };
    }

    const message = formatAlert(alert);

    if (this.dryRun) {
      log.info(`[dry-run] ${formatAlertLine(alert)}`);
      this.dedup.record(fingerprint, now);
      return { sent: false, skipped: 'dry-run', message };
    }

    await this.telegram.sendMessage(message);
    this.dedup.record(fingerprint, now);
    log.info(`alert sent: ${formatAlertLine(alert)}`);
    return { sent: true, message };
  }

  /** Re-seed the dedup window after a restart from previously logged alerts. */
  seedFrom(records = []) {
    this.dedup.seed(
      records.map((r) => ({
        key: `${r.instrumentId}:${r.direction}:${r.poiId || 'no-poi'}`,
        instrumentId: r.instrumentId,
        direction: r.direction,
        entryPrice: r.entryPrice,
        riskDistance: r.riskDistance,
        timestamp: new Date(r.createdAt || r.timestamp).getTime(),
      }))
    );
    return this;
  }
}

module.exports = { AlertService, AlertDeduplicator, TelegramClient, formatAlert, formatAlertLine };
