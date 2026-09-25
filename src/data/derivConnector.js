'use strict';

const WebSocket = require('ws');
const config = require('../config');
const { createLogger } = require('../util/logger');
const { normalize } = require('../util/candles');
const { dropForming } = require('./aggregation');

const log = createLogger('data:deriv');

const GRANULARITIES = [60, 120, 180, 300, 600, 900, 1800, 3600, 7200, 14400, 28800, 86400];

/**
 * Deriv WebSocket connector.
 *
 * Read-only: the bot only ever calls `ticks_history`, never any trade endpoint,
 * so no API token is required and nothing can be executed by accident.
 */
class DerivConnector {
  constructor(opts = {}) {
    this.opts = { ...config.data.deriv, ...opts };
    this.ws = null;
    this.reqId = 0;
    this.pending = new Map();
    this.connecting = null;
    this.closedByUs = false;
    this.reconnectDelay = this.opts.reconnectDelayMs;
    this.WebSocketImpl = opts.WebSocketImpl || WebSocket;
  }

  get url() {
    // The public endpoint takes no app id; only a custom (legacy-style) URL does.
    const { wsUrl, appId } = this.opts;
    if (!appId || wsUrl.includes('/ws/public')) return wsUrl;
    return `${wsUrl}${wsUrl.includes('?') ? '&' : '?'}app_id=${appId}`;
  }

  connect() {
    if (this.ws && this.ws.readyState === 1) return Promise.resolve(this.ws);
    if (this.connecting) return this.connecting;

    this.closedByUs = false;
    this.connecting = new Promise((resolve, reject) => {
      const ws = new this.WebSocketImpl(this.url);
      const onOpen = () => {
        log.info('connected');
        this.reconnectDelay = this.opts.reconnectDelayMs;
        this.ws = ws;
        this.connecting = null;
        resolve(ws);
      };
      const onError = (err) => {
        log.error('socket error:', err && err.message);
        this.connecting = null;
        this._failAllPending(err instanceof Error ? err : new Error(String(err)));
        reject(err);
      };

      ws.on('open', onOpen);
      ws.on('error', onError);
      ws.on('message', (raw) => this._onMessage(raw));
      ws.on('close', () => {
        this.ws = null;
        // Deriv drops idle connections after about a minute. With nothing in
        // flight that is harmless: the next request reconnects on demand, so
        // there is no need to hold a socket open between scans.
        const interrupted = this.pending.size > 0;
        this._failAllPending(new Error('Deriv socket closed'));
        if (this.closedByUs) return;
        if (!interrupted) {
          log.debug('idle connection closed by the server');
          return;
        }
        log.warn('socket closed with requests in flight');
        this._scheduleReconnect();
      });
    });

    return this.connecting;
  }

  _scheduleReconnect() {
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.opts.maxReconnectDelayMs);
    log.info(`reconnecting in ${delay}ms`);
    this._reconnectTimer = setTimeout(() => {
      this.connect().catch((e) => log.error('reconnect failed:', e.message));
    }, delay);
    if (this._reconnectTimer.unref) this._reconnectTimer.unref();
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      log.warn('unparseable message');
      return;
    }
    const id = msg.req_id;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (msg.error) {
      entry.reject(new Error(`Deriv API error ${msg.error.code}: ${msg.error.message}`));
      return;
    }
    entry.resolve(msg);
  }

  _failAllPending(err) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  async send(payload) {
    const ws = await this.connect();
    this.reqId += 1;
    const req_id = this.reqId;
    const message = { ...payload, req_id };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(req_id);
        reject(new Error(`Deriv request timed out after ${this.opts.requestTimeoutMs}ms`));
      }, this.opts.requestTimeoutMs);
      if (timer.unref) timer.unref();

      this.pending.set(req_id, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify(message));
      } catch (err) {
        this.pending.delete(req_id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  /**
   * Fetch closed candles for a Deriv symbol.
   * @param {string} symbol   e.g. 'R_75'
   * @param {number} tfSeconds one of the supported granularities
   * @param {number} count    number of candles
   */
  async fetchCandles(symbol, tfSeconds, count = 300) {
    if (!GRANULARITIES.includes(tfSeconds)) {
      throw new Error(`Deriv does not support a ${tfSeconds}s granularity natively`);
    }
    const res = await this.send({
      ticks_history: symbol,
      adjust_start_time: 1,
      count,
      end: 'latest',
      style: 'candles',
      granularity: tfSeconds,
    });

    const raw = res.candles || [];
    const candles = normalize(
      raw.map((c) => ({
        time: Number(c.epoch),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: 0,
      }))
    );
    return dropForming(candles, tfSeconds);
  }

  /**
   * The tradeable symbol list. Used by the calibration script to confirm the
   * symbols in the instrument registry actually exist on the feed.
   */
  async fetchActiveSymbols(productType = 'basic') {
    const res = await this.send({ active_symbols: 'brief', product_type: productType });
    return res.active_symbols || [];
  }

  close() {
    this.closedByUs = true;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._failAllPending(new Error('connector closed'));
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

module.exports = { DerivConnector, GRANULARITIES };
