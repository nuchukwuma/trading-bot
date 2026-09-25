'use strict';

const { DerivConnector } = require('./derivConnector');
const { OandaConnector } = require('./oandaConnector');
const aggregation = require('./aggregation');
const { createLogger } = require('../util/logger');
const { mergeSeries } = require('../util/candles');

const log = createLogger('data');

/**
 * Routes each instrument to its data source and caches candle series between
 * scans so a 30m scan only pulls what it needs.
 */
class MarketDataService {
  constructor(opts = {}) {
    this.deriv = opts.deriv || new DerivConnector();
    this.oanda = opts.oanda || new OandaConnector();
    this.cache = new Map(); // `${instrumentId}:${tfSeconds}` -> candles
  }

  connectorFor(instrument) {
    switch (instrument.source) {
      case 'deriv':
        return this.deriv;
      case 'oanda':
        return this.oanda;
      default:
        throw new Error(`Unknown data source "${instrument.source}" for ${instrument.id}`);
    }
  }

  async getCandles(instrument, tfSeconds, count) {
    const key = `${instrument.id}:${tfSeconds}`;
    const connector = this.connectorFor(instrument);
    const fresh = await connector.fetchCandles(instrument.symbol, tfSeconds, count);
    const merged = mergeSeries(this.cache.get(key), fresh, count);
    this.cache.set(key, merged);
    log.debug(`${instrument.id} ${tfSeconds}s -> ${merged.length} candles`);
    return merged;
  }

  /**
   * Long history for the backtest: `days` back from now, both timeframes.
   * Deriv pages as far as its history goes; other feeds give what one request
   * can (their connectors have no paging yet).
   */
  async getHistory(instrument, { days, htfSeconds, ltfSeconds, onPage = null }) {
    const connector = this.connectorFor(instrument);
    const to = Math.floor(Date.now() / 1000);
    const from = to - days * 86400;
    if (typeof connector.fetchHistory === 'function') {
      const ltf = await connector.fetchHistory(instrument.symbol, ltfSeconds, { from, to, onPage });
      // Extra 4H history before the first 30m bar, so the bias has context.
      const htf = await connector.fetchHistory(instrument.symbol, htfSeconds, { from: from - 300 * htfSeconds, to });
      return { htf, ltf };
    }
    const ltfCount = Math.min(5000, Math.ceil((days * 86400) / ltfSeconds));
    return this.getBiasAndEntryCandles(instrument, {
      htfSeconds,
      ltfSeconds,
      ltfCount,
      htfCount: Math.min(5000, Math.ceil(ltfCount / 8) + 300),
    });
  }

  /** Both timeframes for one instrument, fetched in parallel. */
  async getBiasAndEntryCandles(instrument, { htfSeconds, ltfSeconds, htfCount, ltfCount }) {
    const [htf, ltf] = await Promise.all([
      this.getCandles(instrument, htfSeconds, htfCount),
      this.getCandles(instrument, ltfSeconds, ltfCount),
    ]);
    return { htf, ltf };
  }

  close() {
    this.deriv.close();
    this.oanda.close();
  }
}

module.exports = {
  MarketDataService,
  DerivConnector,
  OandaConnector,
  ...aggregation,
};
