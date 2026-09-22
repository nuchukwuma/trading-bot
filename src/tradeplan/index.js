'use strict';

const config = require('../config');
const { calculatePositionSize } = require('./positionSize');
const { buildTargets, managementSteps, validateLadder } = require('./targets');
const { nextLiquidityPool, equalTolerance } = require('../liquidity');
const { distalEdge } = require('../poi/mitigation');
const { formatPrice, formatDistance, formatMoney, formatLots } = require('../util/format');

/**
 * Build the full trade plan and apply the hard gates.
 *
 * Entry — the POI edge price meets first, never a level already traded through.
 * Stop  — a FIXED per-instrument buffer beyond whichever is further away: the
 *         sweep wick that took the liquidity, or the far edge of the POI.
 *         Deliberately not ATR-scaled, so the same setup always risks the same
 *         distance on a given instrument.
 * Gates — TP1 R:R must reach `minRiskReward` (1:2). Below that the setup is
 *         discarded outright, whatever the confirmation score.
 */
function buildTradePlan(input) {
  const cfg = { ...config.tradePlan, ...(input.opts || {}) };
  const { instrument, direction, entryPrice, poi, sweep } = input;
  const bullish = direction === 'bullish';

  const ladder = validateLadder(cfg.targets);
  if (!ladder.valid) {
    return reject('config', `Take-profit ladder closes ${ladder.total}% of the position, not 100%`);
  }
  if (!Number.isFinite(entryPrice)) {
    return reject('entry', 'No usable entry price');
  }

  // ---- stop loss ----
  const stopAnchor = resolveStopAnchor({ direction, poi, sweep, entryPrice });
  if (stopAnchor === null) {
    return reject('stop', 'No sweep or POI to anchor the stop against');
  }
  const buffer = Number.isFinite(input.slBuffer) ? input.slBuffer : instrument.slBuffer;
  const stopPrice = bullish ? stopAnchor - buffer : stopAnchor + buffer;
  const riskDistance = Math.abs(entryPrice - stopPrice);

  if (!(riskDistance > 0)) {
    return reject('stop', 'Stop landed on the entry price');
  }

  // ---- targets ----
  const obstacle = resolveObstacle(input, entryPrice, direction);
  const targets = buildTargets({ direction, entryPrice, riskDistance, obstacle, targets: cfg.targets });
  const tp1 = targets[0];

  // ---- hard R:R gate ----
  if (tp1.rr + 1e-9 < cfg.minRiskReward) {
    return reject(
      'risk_reward',
      `TP1 R:R is 1:${tp1.rr.toFixed(2)}, below the 1:${cfg.minRiskReward} minimum${
        tp1.cappedBy ? ` (capped by ${describeObstacle(tp1.cappedBy, instrument)})` : ''
      }`,
      { entryPrice, stopPrice, riskDistance, targets }
    );
  }

  // ---- position size ----
  const position = calculatePositionSize({
    instrument,
    entryPrice,
    stopPrice,
    riskUsd: Number.isFinite(input.riskUsd) ? input.riskUsd : config.risk.riskPerTrade,
    rates: input.rates || {},
  });
  if (!position.valid) {
    return reject('sizing', position.warnings[0] || 'Position size could not be calculated', { entryPrice, stopPrice });
  }

  const fmt = (n) => formatPrice(n, instrument);

  return {
    valid: true,
    rejected: false,
    direction,
    side: bullish ? 'BUY' : 'SELL',
    instrumentId: instrument.id,
    entryPrice,
    entryZone: poi ? { top: poi.top, bottom: poi.bottom } : null,
    stopPrice,
    stopAnchor,
    stopBuffer: buffer,
    riskDistance,
    riskDistanceLabel: formatDistance(riskDistance, instrument),
    targets,
    obstacle,
    riskReward: tp1.rr,
    position,
    management: managementSteps(targets, fmt),
    warnings: position.warnings,
    summary: `${bullish ? 'BUY' : 'SELL'} ${instrument.id} @ ${fmt(entryPrice)} | SL ${fmt(stopPrice)} (${formatDistance(
      riskDistance,
      instrument
    )}) | ${formatLots(position.lots)} lots | risk ${formatMoney(position.actualRiskUsd)}`,
  };
}

/**
 * The stop sits beyond whichever invalidation point is further from entry: the
 * sweep wick (if the setup had one) or the POI's far edge.
 */
function resolveStopAnchor({ direction, poi, sweep, entryPrice }) {
  const candidates = [];
  if (sweep && Number.isFinite(sweep.extreme)) candidates.push(sweep.extreme);
  if (poi) candidates.push(distalEdge(poi));
  if (!candidates.length) return null;

  const beyondEntry = candidates.filter((p) => (direction === 'bullish' ? p < entryPrice : p > entryPrice));
  const usable = beyondEntry.length ? beyondEntry : candidates;
  return direction === 'bullish' ? Math.min(...usable) : Math.max(...usable);
}

/**
 * The nearest thing ahead of the trade that price is likely to react to:
 * a resting liquidity pool, or an opposing unmitigated POI.
 */
function resolveObstacle(input, entryPrice, direction) {
  if (input.obstacle !== undefined) return input.obstacle; // explicit override (tests, tuning)

  const candidates = [];

  if (input.swings && input.swings.length) {
    const pool = nextLiquidityPool(input.swings, entryPrice, direction, {
      candles: input.candles,
      tolerance: input.candles ? equalTolerance(input.candles, input.opts || {}) : 0,
    });
    if (pool) candidates.push({ price: pool.price, kind: pool.kind, count: pool.count, source: 'liquidity' });
  }

  const opposite = direction === 'bullish' ? 'bearish' : 'bullish';
  for (const poi of input.opposingPois || []) {
    if (poi.direction !== opposite || poi.mitigated || poi.violated) continue;
    const edge = direction === 'bullish' ? poi.bottom : poi.top;
    const ahead = direction === 'bullish' ? edge > entryPrice : edge < entryPrice;
    if (ahead) candidates.push({ price: edge, kind: poi.kind, source: 'poi', timeframe: poi.timeframe });
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => Math.abs(a.price - entryPrice) - Math.abs(b.price - entryPrice));
  return candidates[0];
}

function describeObstacle(obstacle, instrument) {
  const what =
    obstacle.kind === 'EQH' || obstacle.kind === 'EQL'
      ? `${obstacle.kind} liquidity (${obstacle.count})`
      : obstacle.source === 'poi'
        ? `an opposing ${obstacle.kind}`
        : 'the next swing';
  return `${what} at ${formatPrice(obstacle.price, instrument)}`;
}

function reject(gate, reason, details = {}) {
  return { valid: false, rejected: true, gate, reason, ...details };
}

module.exports = {
  buildTradePlan,
  resolveStopAnchor,
  resolveObstacle,
  describeObstacle,
  ...require('./targets'),
  ...require('./positionSize'),
};
