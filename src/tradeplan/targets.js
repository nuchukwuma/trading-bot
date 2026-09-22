'use strict';

const config = require('../config');

/**
 * Take-profit ladder.
 *
 * Nominal prices come from the configured R multiples (1:2 / 1:3.5 / 1:5).
 * A target is then CAPPED at the nearest obstacle ahead of the trade — the next
 * major liquidity pool or an opposing unmitigated POI — because price is far
 * more likely to react there than to run cleanly to the nominal level.
 *
 * Capping is what makes the R:R gate meaningful: if the obstacle sits closer
 * than 2R, TP1's real R:R drops below 1:2 and the setup is discarded.
 */
function buildTargets({ direction, entryPrice, riskDistance, obstacle = null, targets = config.tradePlan.targets }) {
  const sign = direction === 'bullish' ? 1 : -1;
  const beyond = (price) => (direction === 'bullish' ? price > entryPrice : price < entryPrice);
  const capActive = obstacle !== null && Number.isFinite(obstacle.price) && beyond(obstacle.price);

  let remaining = 100;

  return targets.map((spec) => {
    const nominal = entryPrice + sign * riskDistance * spec.rr;
    let price = nominal;
    let cappedBy = null;

    if (capActive) {
      const nearer = direction === 'bullish' ? obstacle.price < nominal : obstacle.price > nominal;
      if (nearer) {
        price = obstacle.price;
        cappedBy = obstacle;
      }
    }

    const rr = riskDistance > 0 ? Math.abs(price - entryPrice) / riskDistance : 0;
    remaining -= spec.closePct;

    return {
      name: spec.name,
      price,
      nominalPrice: nominal,
      rr,
      nominalRr: spec.rr,
      closePct: spec.closePct,
      remainingPct: Math.max(0, remaining),
      cappedBy,
      moveStopToBreakeven: Boolean(spec.moveStopToBreakeven),
      trailToStructure: Boolean(spec.trailToStructure),
    };
  });
}

/**
 * Plain-English management steps for the alert body. This is guidance for the
 * human reading the alert — the bot never manages a position itself.
 */
function managementSteps(targets, format = (n) => String(n)) {
  const steps = [];
  for (const t of targets) {
    const parts = [`${t.name} at ${format(t.price)} (${t.rr.toFixed(2)}R) — close ${t.closePct}%`];
    if (t.moveStopToBreakeven) parts.push('move stop to breakeven');
    if (t.trailToStructure) parts.push('trail the stop behind 30m structure');
    if (t.remainingPct > 0) parts.push(`${t.remainingPct}% left running`);
    steps.push(parts.join(', '));
  }
  return steps;
}

/** The configured ladder must close exactly 100% of the position. */
function validateLadder(targets = config.tradePlan.targets) {
  const total = targets.reduce((sum, t) => sum + t.closePct, 0);
  return { valid: total === 100, total };
}

module.exports = { buildTargets, managementSteps, validateLadder };
