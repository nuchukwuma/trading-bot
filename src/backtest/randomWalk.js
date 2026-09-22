'use strict';

const { aggregateCandles } = require('../data/aggregation');

/**
 * Deterministic geometric-random-walk candles.
 *
 * Used to sanity-check the harness, not to evaluate the strategy. A random
 * walk has no structure to find, so a correct backtester must report roughly
 * zero-to-negative expectancy on it. If the harness ever shows a healthy edge
 * here, the harness is broken — that is the whole point of having this.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller normal from a uniform generator. */
function normal(rand) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * @param {object} opts
 * @param {number} opts.bars       number of candles
 * @param {number} opts.start      starting price
 * @param {number} opts.volatility per-candle standard deviation, as a fraction
 * @param {number} opts.drift      per-candle drift, as a fraction (0 = no edge)
 * @param {number} opts.seed       deterministic seed
 */
function randomWalkCandles({
  bars = 2000,
  start = 1000,
  volatility = 0.004,
  drift = 0,
  seed = 1,
  tfSeconds = 1800,
  startTime = 1700000000,
  ticksPerBar = 12,
} = {}) {
  const rand = mulberry32(seed);
  const candles = [];
  let price = start;

  for (let i = 0; i < bars; i += 1) {
    const open = price;
    let high = open;
    let low = open;
    // Walk within the bar so highs and lows are consistent with the close.
    for (let k = 0; k < ticksPerBar; k += 1) {
      price *= Math.exp(drift / ticksPerBar + (volatility / Math.sqrt(ticksPerBar)) * normal(rand));
      high = Math.max(high, price);
      low = Math.min(low, price);
    }
    candles.push({
      time: startTime + i * tfSeconds,
      open: round(open),
      high: round(high),
      low: round(low),
      close: round(price),
      volume: 0,
    });
  }
  return candles;
}

/** A matching 4H series built from the same 30m walk. */
function randomWalkSeries(opts = {}) {
  const ltf = randomWalkCandles(opts);
  const last = ltf[ltf.length - 1];
  const htf = aggregateCandles(ltf, 14400, { now: last.time + 1800 });
  return { ltf, htf };
}

const round = (n) => Number(n.toFixed(4));

module.exports = { randomWalkCandles, randomWalkSeries, mulberry32 };
