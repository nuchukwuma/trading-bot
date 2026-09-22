'use strict';

const config = require('../config');
const { createLogger } = require('../util/logger');
const { normalize } = require('../util/candles');
const { aggregateCandles } = require('./aggregation');

const log = createLogger('data:oanda');

/** Seconds -> OANDA granularity code. */
const GRANULARITY_BY_SECONDS = {
  60: 'M1',
  300: 'M5',
  900: 'M15',
  1800: 'M30',
  3600: 'H1',
  7200: 'H2',
  14400: 'H4',
  86400: 'D',
};

/**
 * OANDA v20 REST connector (practice or live).
 * Read-only: only the /candles endpoint is used.
 */
class OandaConnector {
  constructor(opts = {}) {
    this.opts = { ...config.data.oanda, ...opts };
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
  }

  get configured() {
    return Boolean(this.opts.apiKey);
  }

  async _get(path, params) {
    if (!this.configured) {
      throw new Error('OANDA_API_KEY is not set — forex instruments cannot be scanned');
    }
    const url = new URL(path, this.opts.apiUrl);
    for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, String(v));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.requestTimeoutMs);
    try {
      const res = await this.fetchImpl(url.toString(), {
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          'Content-Type': 'application/json',
          'Accept-Datetime-Format': 'UNIX',
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`OANDA ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fetch closed candles. Timeframes OANDA does not serve natively are
   * requested one step down and aggregated locally.
   */
  async fetchCandles(symbol, tfSeconds, count = 300) {
    const granularity = GRANULARITY_BY_SECONDS[tfSeconds];
    if (granularity) {
      const json = await this._get(`/v3/instruments/${symbol}/candles`, {
        granularity,
        count: Math.min(count, 5000),
        price: this.opts.price,
      });
      return this._map(json.candles || []);
    }

    // Aggregate from M30 when the requested timeframe has no native code.
    const step = 1800;
    if (tfSeconds % step !== 0) {
      throw new Error(`Unsupported OANDA timeframe: ${tfSeconds}s`);
    }
    const needed = Math.min(count * (tfSeconds / step) + step, 5000);
    const json = await this._get(`/v3/instruments/${symbol}/candles`, {
      granularity: 'M30',
      count: needed,
      price: this.opts.price,
    });
    const base = this._map(json.candles || []);
    log.debug(`aggregated ${base.length} M30 candles into ${tfSeconds}s`);
    return aggregateCandles(base, tfSeconds);
  }

  _map(raw) {
    const priceKey = this.opts.price === 'B' ? 'bid' : this.opts.price === 'A' ? 'ask' : 'mid';
    return normalize(
      raw
        .filter((c) => c.complete) // never hand a forming candle to the engines
        .map((c) => {
          const p = c[priceKey] || c.mid;
          return {
            time: Math.floor(Number(c.time)),
            open: Number(p.o),
            high: Number(p.h),
            low: Number(p.l),
            close: Number(p.c),
            volume: Number(c.volume || 0),
          };
        })
    );
  }

  /** Latest mid price, used for quote-currency -> USD conversion. */
  async fetchLatestPrice(symbol) {
    const candles = await this.fetchCandles(symbol, 60, 1);
    return candles.length ? candles[candles.length - 1].close : null;
  }

  close() {
    /* stateless */
  }
}

module.exports = { OandaConnector, GRANULARITY_BY_SECONDS };
