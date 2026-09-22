'use strict';

const config = require('../config');
const poiLib = require('../poi');
const { detectSweeps } = require('../liquidity');
const { findDisplacement } = require('../structure/displacement');
const { zoneOf, positionInRange, isFavourableZone } = require('../structure/range');
const { overlapRatio } = require('../poi/mitigation');
const { formatPrice } = require('../util/format');

/**
 * The six confirmation checks. Each returns
 *   { id, name, passed, reason, details }
 * where `reason` is the one-line human-readable sentence that goes into the
 * Telegram alert when the check fires.
 */

function result(id, name, passed, reason, details = {}) {
  return { id, name, passed, reason, details };
}

/** 1. 30m BOS/CHoCH aligned with the HTF bias. */
function checkStructureAlignment(ctx) {
  const { ltfStructure, bias, ltfCandles } = ctx;
  const cfg = { ...config.scoring, ...(ctx.opts.scoring || {}) };
  const event = ltfStructure.lastEvent;
  const id = 'ltf_structure';
  const name = '30m structure shift aligned with HTF bias';

  if (!event) return result(id, name, false, 'No 30m structural break yet', {});

  const age = ltfCandles.length - 1 - event.index;
  if (event.direction !== bias.direction) {
    return result(id, name, false, `Latest 30m ${event.type} is ${event.direction}, against the ${bias.direction} 4H bias`, {
      event,
      age,
    });
  }
  if (age > cfg.maxEventAgeCandles) {
    return result(id, name, false, `30m ${event.type} is stale (${age} candles ago)`, { event, age });
  }

  const label = event.type === 'CHoCH' ? 'Change of character' : 'Break of structure';
  return result(
    id,
    name,
    true,
    `30m ${event.type} aligned with HTF bias — ${label.toLowerCase()} ${
      event.direction === 'bullish' ? 'above' : 'below'
    } ${formatPrice(event.brokenSwing.price, ctx.instrument)} confirms the ${bias.direction} 4H read`,
    { event, age }
  );
}

/** 2. Liquidity sweep (EQH/EQL or single-candle wick) before the shift. */
function checkLiquiditySweep(ctx) {
  const { ltfCandles, ltfStructure, bias } = ctx;
  const id = 'liquidity_sweep';
  const name = 'Liquidity swept before the shift';
  const breakIndex = ltfStructure.lastEvent ? ltfStructure.lastEvent.index : ltfCandles.length - 1;

  const sweeps = detectSweeps(ltfCandles, ltfStructure.swings, {
    breakIndex,
    direction: bias.direction,
    instrument: ctx.instrument,
    ...(ctx.opts.liquidity || {}),
  });

  if (!sweeps.length) {
    return result(id, name, false, 'No liquidity sweep found ahead of the shift', { sweeps: [] });
  }

  const best = sweeps[0];
  return result(id, name, true, best.reason, { sweep: best, sweeps });
}

/** 3. Retrace into an unmitigated 30m order block or FVG. */
function checkPoiRetrace(ctx) {
  const { ltfPois, price, bias } = ctx;
  const id = 'poi_retrace';
  const name = 'Retrace into an unmitigated 30m POI';

  const inside = poiLib.poisContaining(ltfPois, price, bias.direction);
  if (inside.length) {
    const p = inside[0];
    return result(
      id,
      name,
      true,
      `Retrace into an unmitigated 30m ${p.kind === 'OB' ? 'order block' : 'fair value gap'} at ${formatPrice(
        p.bottom,
        ctx.instrument
      )}-${formatPrice(p.top, ctx.instrument)} — price is mitigating the zone now`,
      { poi: p }
    );
  }

  const nearest = poiLib.nearestUnmitigated(ltfPois, price, bias.direction);
  return result(id, name, false, nearest ? 'Price has not yet retraced into the 30m POI' : 'No unmitigated 30m POI to retrace into', {
    poi: nearest,
  });
}

/** 4. Entry zone in discount (longs) / premium (shorts) of the 50% range. */
function checkPremiumDiscount(ctx) {
  const { entryPrice, ltfRange, bias } = ctx;
  const id = 'premium_discount';
  const name = 'Entry in discount (longs) / premium (shorts)';

  if (!ltfRange) return result(id, name, false, 'No usable dealing range to measure premium/discount', {});

  const zone = zoneOf(entryPrice, ltfRange);
  const pos = positionInRange(entryPrice, ltfRange);
  const pct = pos === null ? '?' : `${(pos * 100).toFixed(0)}%`;
  const ok = isFavourableZone(entryPrice, ltfRange, bias.direction);
  const want = bias.direction === 'bullish' ? 'discount' : 'premium';

  return result(
    id,
    name,
    ok,
    ok
      ? `Entry sits in ${zone} at ${pct} of the dealing range — ${
          bias.direction === 'bullish' ? 'longs' : 'shorts'
        } are priced correctly against the 50% equilibrium`
      : `Entry sits in ${zone} at ${pct} of the range — ${bias.direction === 'bullish' ? 'longs' : 'shorts'} want ${want}`,
    { zone, position: pos, equilibrium: ltfRange.equilibrium }
  );
}

/** 5. The 30m entry zone overlaps an unmitigated 4H POI. */
function checkHtfConfluence(ctx) {
  const { entryZone, bias } = ctx;
  const id = 'htf_confluence';
  const name = 'Confluence with an unmitigated HTF POI';

  if (!entryZone) return result(id, name, false, 'No 30m entry zone to compare against the 4H POIs', {});

  const matches = poiLib.overlappingPOIs(bias.pois || [], entryZone, bias.direction);
  if (!matches.length) {
    return result(id, name, false, 'The 30m entry zone does not overlap any unmitigated 4H POI', {});
  }

  const best = matches
    .map((p) => ({ poi: p, ratio: overlapRatio(entryZone, p) }))
    .sort((a, b) => b.ratio - a.ratio)[0];

  return result(
    id,
    name,
    true,
    `Confluence with an HTF POI — the 30m zone sits inside the unmitigated 4H ${
      best.poi.kind === 'OB' ? 'order block' : 'fair value gap'
    } at ${formatPrice(best.poi.bottom, ctx.instrument)}-${formatPrice(best.poi.top, ctx.instrument)}`,
    { poi: best.poi, overlap: best.ratio }
  );
}

/** 6. Displacement candle driving the move. */
function checkDisplacement(ctx) {
  const { ltfCandles, ltfStructure, bias } = ctx;
  const id = 'displacement';
  const name = 'Displacement candle drove the move';
  const cfg = { ...config.displacement, ...(ctx.opts.displacement || {}) };
  const anchor = ltfStructure.lastEvent ? ltfStructure.lastEvent.index : ltfCandles.length - 1;

  const d = findDisplacement(ltfCandles, anchor, bias.direction, cfg);
  if (!d) {
    return result(id, name, false, `No displacement candle within ${cfg.lookback} candles of the shift`, {});
  }

  return result(
    id,
    name,
    true,
    `Displacement candle drove the move — body ${d.ratio.toFixed(1)}x the ${cfg.avgPeriod}-period average range`,
    { displacement: d }
  );
}

/**
 * The canonical check ids, in the order the scorer runs them. Declared rather
 * than derived so other modules (the backtest analyser, stored edge profiles)
 * can reference them without invoking a check. `tests/scoring.test.js` asserts
 * this stays in step with what the checks actually return.
 */
const CHECK_IDS = [
  'ltf_structure',
  'liquidity_sweep',
  'poi_retrace',
  'premium_discount',
  'htf_confluence',
  'displacement',
];

const CHECKS = [
  checkStructureAlignment,
  checkLiquiditySweep,
  checkPoiRetrace,
  checkPremiumDiscount,
  checkHtfConfluence,
  checkDisplacement,
];

module.exports = {
  CHECKS,
  CHECK_IDS,
  checkStructureAlignment,
  checkLiquiditySweep,
  checkPoiRetrace,
  checkPremiumDiscount,
  checkHtfConfluence,
  checkDisplacement,
};
