'use strict';

/**
 * Candle shape used everywhere in this project:
 *   { time: <epoch seconds, candle OPEN time>, open, high, low, close, volume? }
 * Arrays are always oldest -> newest, with the last element the most recently
 * CLOSED candle (the scanner never feeds a forming candle to the engines).
 */

function isCandle(c) {
  return (
    c &&
    Number.isFinite(c.time) &&
    Number.isFinite(c.open) &&
    Number.isFinite(c.high) &&
    Number.isFinite(c.low) &&
    Number.isFinite(c.close)
  );
}

function assertCandles(candles, label = 'candles') {
  if (!Array.isArray(candles)) throw new TypeError(`${label} must be an array`);
  for (let i = 0; i < candles.length; i += 1) {
    if (!isCandle(candles[i])) throw new TypeError(`${label}[${i}] is not a valid candle`);
  }
  return candles;
}

const body = (c) => Math.abs(c.close - c.open);
const range = (c) => c.high - c.low;
const isBullish = (c) => c.close > c.open;
const isBearish = (c) => c.close < c.open;
const upperWick = (c) => c.high - Math.max(c.open, c.close);
const lowerWick = (c) => Math.min(c.open, c.close) - c.low;

/** Simple average true-ish range: mean of (high-low) over the last `period` candles. */
function averageRange(candles, period = 20, endIndex = candles.length - 1) {
  if (!candles.length) return 0;
  const end = Math.min(endIndex, candles.length - 1);
  const start = Math.max(0, end - period + 1);
  let sum = 0;
  let n = 0;
  for (let i = start; i <= end; i += 1) {
    sum += range(candles[i]);
    n += 1;
  }
  return n ? sum / n : 0;
}

/** Mean absolute body size over the last `period` candles ending at `endIndex`. */
function averageBody(candles, period = 20, endIndex = candles.length - 1) {
  if (!candles.length) return 0;
  const end = Math.min(endIndex, candles.length - 1);
  const start = Math.max(0, end - period + 1);
  let sum = 0;
  let n = 0;
  for (let i = start; i <= end; i += 1) {
    sum += body(candles[i]);
    n += 1;
  }
  return n ? sum / n : 0;
}

/** Highest high / lowest low over a window (inclusive indices). */
function highestHigh(candles, from = 0, to = candles.length - 1) {
  let best = -Infinity;
  let index = -1;
  for (let i = Math.max(0, from); i <= Math.min(to, candles.length - 1); i += 1) {
    if (candles[i].high > best) {
      best = candles[i].high;
      index = i;
    }
  }
  return { price: best, index };
}

function lowestLow(candles, from = 0, to = candles.length - 1) {
  let best = Infinity;
  let index = -1;
  for (let i = Math.max(0, from); i <= Math.min(to, candles.length - 1); i += 1) {
    if (candles[i].low < best) {
      best = candles[i].low;
      index = i;
    }
  }
  return { price: best, index };
}

/** Sort ascending by time and drop duplicates (keeping the later revision). */
function normalize(candles) {
  const byTime = new Map();
  for (const c of candles) {
    if (!isCandle(c)) continue;
    byTime.set(c.time, c);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** Merge new candles into an existing series, keeping at most `limit` of them. */
function mergeSeries(existing, incoming, limit = Infinity) {
  const merged = normalize([...(existing || []), ...(incoming || [])]);
  return merged.length > limit ? merged.slice(merged.length - limit) : merged;
}

module.exports = {
  isCandle,
  assertCandles,
  body,
  range,
  isBullish,
  isBearish,
  upperWick,
  lowerWick,
  averageRange,
  averageBody,
  highestHigh,
  lowestLow,
  normalize,
  mergeSeries,
};
