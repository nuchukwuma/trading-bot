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
