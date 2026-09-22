'use strict';

/**
 * Sample statistics for a set of backtested trades.
 *
 * Everything here reports a LOWER CONFIDENCE BOUND alongside the point
 * estimate. Picking the best-looking bucket out of dozens is exactly how a
 * backtest invents an edge that is not there, and a raw win rate on 12 trades
 * carries no information. The selector only ever ranks on the bounds.
 */

const Z_95 = 1.959964;

/**
 * Wilson score interval lower bound for a proportion. Well behaved at small
 * n and near 0 or 1, unlike the normal approximation.
 */
function wilsonLowerBound(successes, n, z = Z_95) {
  if (n <= 0) return 0;
  const p = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - margin) / denominator);
}

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function stdev(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1));
}

/** Largest peak-to-trough fall of the cumulative R curve. */
function maxDrawdown(rs) {
  let peak = 0;
  let equity = 0;
  let worst = 0;
  for (const r of rs) {
    equity += r;
    peak = Math.max(peak, equity);
    worst = Math.min(worst, equity - peak);
  }
  return worst;
}

/**
 * @param {Array} trades  backtest trade records
 * @returns {object} summary, including the 95% lower bound on expectancy —
 *                   the number the profile selector actually ranks on.
 */
function summarize(trades) {
  const filled = trades.filter((t) => t.filled);
  const rs = filled.map((t) => t.rMultiple);
  const n = rs.length;

  if (n === 0) {
    return {
      n: 0,
      trades: trades.length,
      wins: 0,
      losses: 0,
      winRate: 0,
      winRateLower: 0,
      expectancy: 0,
      expectancyLower: 0,
      expectancyUpper: 0,
      totalR: 0,
      avgWin: 0,
      avgLoss: 0,
      profitFactor: 0,
      maxDrawdownR: 0,
      stdev: 0,
    };
  }

  const wins = rs.filter((r) => r > 0);
  const losses = rs.filter((r) => r <= 0);
  const expectancy = mean(rs);
  const sd = stdev(rs);
  const standardError = n > 1 ? sd / Math.sqrt(n) : 0;
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));

  return {
    n,
    trades: trades.length,
    unfilled: trades.length - n,
    wins: wins.length,
    losses: losses.length,
    winRate: wins.length / n,
    winRateLower: wilsonLowerBound(wins.length, n),
    expectancy,
    // A bucket only counts as edge when even the pessimistic end of the
    // interval is positive.
    expectancyLower: expectancy - Z_95 * standardError,
    expectancyUpper: expectancy + Z_95 * standardError,
    totalR: rs.reduce((a, b) => a + b, 0),
    avgWin: wins.length ? mean(wins) : 0,
    avgLoss: losses.length ? mean(losses) : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    maxDrawdownR: maxDrawdown(rs),
    stdev: sd,
  };
}

/** Group trades by an arbitrary key, returning plain objects for reporting. */
function bucketBy(trades, keyFn) {
  const groups = new Map();
  for (const t of trades) {
    const key = keyFn(t);
    if (key === null || key === undefined) continue;
    const list = groups.get(String(key));
    if (list) list.push(t);
    else groups.set(String(key), [t]);
  }
  return [...groups.entries()]
    .map(([key, list]) => ({ key, ...summarize(list) }))
    .sort((a, b) => b.expectancyLower - a.expectancyLower);
}

/**
 * Abramowitz & Stegun 7.1.26 error function, good to ~1e-7 — ample for the
 * p-values used here.
 */
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

const normalCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

/**
 * Welch's t-test comparing the mean R of two groups (unequal variance).
 * The p-value uses a normal approximation, which is fine at the sample sizes
 * the learner insists on (30+ per group) and conservative below them.
 */
function welchTest(a, b) {
  const n1 = a.length;
  const n2 = b.length;
  if (n1 < 2 || n2 < 2) return { t: 0, p: 1, diff: 0, n1, n2 };

  const m1 = mean(a);
  const m2 = mean(b);
  const v1 = stdev(a) ** 2 / n1;
  const v2 = stdev(b) ** 2 / n2;
  const se = Math.sqrt(v1 + v2);
  if (!(se > 0)) return { t: 0, p: 1, diff: m1 - m2, n1, n2 };

  const t = (m1 - m2) / se;
  const p = 2 * (1 - normalCdf(Math.abs(t)));
  return { t, p: Math.min(1, Math.max(0, p)), diff: m1 - m2, n1, n2 };
}

/**
 * Benjamini-Hochberg false discovery rate control.
 *
 * The learner tests dozens of candidate features at once. Without this, at
 * p < 0.05 roughly one in twenty worthless features looks significant purely
 * by chance — and with 70+ tokens that guarantees a handful of invented
 * "patterns" every run.
 *
 * @param {Array<number>} pValues
 * @param {number} q  tolerated false discovery rate
 * @returns {Array<boolean>} which hypotheses survive, in the input order
 */
function benjaminiHochberg(pValues, q = 0.1) {
  const m = pValues.length;
  if (m === 0) return [];

  const indexed = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  let cutoffRank = -1;
  for (let k = 0; k < m; k += 1) {
    if (indexed[k].p <= ((k + 1) / m) * q) cutoffRank = k;
  }

  const rejected = new Array(m).fill(false);
  for (let k = 0; k <= cutoffRank; k += 1) rejected[indexed[k].i] = true;
  return rejected;
}

module.exports = {
  summarize,
  bucketBy,
  wilsonLowerBound,
  maxDrawdown,
  mean,
  stdev,
  erf,
  normalCdf,
  welchTest,
  benjaminiHochberg,
  Z_95,
};
