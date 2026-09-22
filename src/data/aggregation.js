'use strict';

const { bucketStart } = require('../util/time');
const { normalize } = require('../util/candles');

/**
 * Aggregate candles of a smaller timeframe into a larger one.
 * Only buckets whose window is fully in the past are emitted when
 * `dropIncomplete` is true (the default) — the engines must never see a
 * forming candle.
 */
function aggregateCandles(candles, tfSeconds, { dropIncomplete = true, now = Date.now() / 1000 } = {}) {
  const src = normalize(candles);
  const buckets = new Map();

  for (const c of src) {
    const start = bucketStart(c.time, tfSeconds);
    const b = buckets.get(start);
    if (!b) {
      buckets.set(start, {
        time: start,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume || 0,
        lastSrcTime: c.time,
      });
    } else {
      b.high = Math.max(b.high, c.high);
      b.low = Math.min(b.low, c.low);
      b.close = c.close;
      b.volume += c.volume || 0;
      b.lastSrcTime = c.time;
    }
  }

  let out = [...buckets.values()].sort((a, b) => a.time - b.time);
  if (dropIncomplete) out = out.filter((b) => b.time + tfSeconds <= now);
  return out.map(({ lastSrcTime, ...rest }) => rest); // eslint-disable-line no-unused-vars
}

/**
 * Fold a stream of ticks ({ epoch, quote }) into candles of `tfSeconds`.
 * Used by the Deriv connector when only a tick stream is available.
 */
function ticksToCandles(ticks, tfSeconds, { dropIncomplete = true, now = Date.now() / 1000 } = {}) {
  const buckets = new Map();
  for (const t of ticks) {
    const price = Number(t.quote ?? t.price);
    const epoch = Number(t.epoch ?? t.time);
    if (!Number.isFinite(price) || !Number.isFinite(epoch)) continue;
    const start = bucketStart(epoch, tfSeconds);
    const b = buckets.get(start);
    if (!b) {
      buckets.set(start, { time: start, open: price, high: price, low: price, close: price, volume: 1 });
    } else {
      b.high = Math.max(b.high, price);
      b.low = Math.min(b.low, price);
      b.close = price;
      b.volume += 1;
    }
  }
  let out = [...buckets.values()].sort((a, b) => a.time - b.time);
  if (dropIncomplete) out = out.filter((b) => b.time + tfSeconds <= now);
  return out;
}

/**
 * Drop the final candle when it has not closed yet, so engines only ever see
 * completed candles. `now` is epoch seconds.
 */
function dropForming(candles, tfSeconds, now = Date.now() / 1000) {
  if (!candles.length) return candles;
  const last = candles[candles.length - 1];
  return last.time + tfSeconds > now ? candles.slice(0, -1) : candles;
}

module.exports = { aggregateCandles, ticksToCandles, dropForming };
