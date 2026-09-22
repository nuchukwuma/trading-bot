'use strict';

const { detectSwings } = require('../structure/swings');

const DEFAULTS = {
  // Give up on a trade that has neither hit a target nor stopped.
  maxBars: 96, // 48 hours of 30m candles
  // A limit entry that never fills within this many bars is abandoned.
  maxBarsToFill: 8,
  // When one candle's range contains BOTH the stop and a target, 30m data
  // cannot say which came first. Assume the stop. This is the single most
  // important setting in the harness: the optimistic alternative inflates
  // every result and is how backtests end up lying.
  pessimistic: true,
  // Swing lookback used when trailing the stop behind structure after TP2.
  trailLookback: 2,
};

/**
 * Replay one trade plan against the candles that followed it.
 *
 * Models the full ladder the alert describes: partial closes at each target,
 * stop to breakeven after TP1, stop trailing behind 30m structure after TP2.
 *
 * Two deliberate conservatisms, both because a 30m candle hides its own
 * sequence of events:
 *   - stop and target in the same candle  -> the stop wins (`pessimistic`)
 *   - a stop moved by a target            -> takes effect from the NEXT candle,
 *                                             so one candle cannot both pay a
 *                                             target and stop out on the stop
 *                                             that target created
 *
 * @param {object}  plan         a valid trade plan from buildTradePlan
 * @param {Array}   candles      candles AFTER the signal bar, oldest first
 * @param {number}  signalClose  close of the signal bar (the market-entry price)
 * @returns {object} outcome
 */
function simulateTrade({ plan, candles, signalClose, opts = {} }) {
  const cfg = { ...DEFAULTS, ...opts };
  const bullish = plan.direction === 'bullish';
  const entry = plan.entryPrice;
  const risk = plan.riskDistance;
  const eps = risk * 1e-9;

  const toR = (price) => ((bullish ? price - entry : entry - price) / risk);

  let filled = Math.abs(entry - signalClose) <= eps;
  let fillBar = filled ? -1 : null; // -1 == filled at the signal close
  let stop = plan.stopPrice;
  let pendingStop = null; // applied from the next bar
  let remaining = 100;
  let realizedR = 0;
  let nextTarget = 0;
  let highestTargetHit = null;
  let status = 'timeout';
  let exitBar = null;
  let mfe = 0;
  let mae = 0;
  const exits = [];

  const closeOut = (pct, price, reason, bar) => {
    realizedR += toR(price) * (pct / 100);
    remaining -= pct;
    exits.push({ pct, price, reason, bar, r: toR(price) });
  };

  const limit = Math.min(candles.length, cfg.maxBars);

  for (let i = 0; i < limit; i += 1) {
    const c = candles[i];

    // ---- pending limit entry ----
    if (!filled) {
      const touched = bullish ? c.low <= entry + eps : c.high >= entry - eps;
      if (touched) {
        filled = true;
        fillBar = i;
      } else if (i >= cfg.maxBarsToFill - 1) {
        status = 'expired';
        exitBar = i;
        break;
      } else {
        continue;
      }
    }

    // A stop change requested by the previous bar becomes live now.
    if (pendingStop !== null) {
      stop = pendingStop;
      pendingStop = null;
    }

    // ---- excursion tracking (for analysis, not for exits) ----
    mfe = Math.max(mfe, toR(bullish ? c.high : c.low));
    mae = Math.min(mae, toR(bullish ? c.low : c.high));

    const stopHit = bullish ? c.low <= stop + eps : c.high >= stop - eps;
    const targetHit = () => {
      const t = plan.targets[nextTarget];
      if (!t) return false;
      return bullish ? c.high >= t.price - eps : c.low <= t.price + eps;
    };

    // ---- stop first when the candle contains both ----
    if (stopHit && (cfg.pessimistic || !targetHit())) {
      closeOut(remaining, stop, 'stop', i);
      status = highestTargetHit || 'stopped';
      exitBar = i;
      break;
    }

    // ---- targets (a single candle may clear more than one) ----
    while (targetHit()) {
      const t = plan.targets[nextTarget];
      closeOut(t.closePct, t.price, t.name, i);
      highestTargetHit = t.name.toLowerCase();
      nextTarget += 1;

      if (t.moveStopToBreakeven) pendingStop = entry;
      if (t.trailToStructure) {
        const trailed = structureStop(candles, i, bullish, cfg.trailLookback);
        if (trailed !== null && better(trailed, pendingStop === null ? stop : pendingStop, bullish)) {
          pendingStop = trailed;
        }
      }

      if (remaining <= 0) {
        status = highestTargetHit;
        exitBar = i;
        break;
      }
    }
    if (remaining <= 0) break;

    // ---- keep trailing once TP2 has gone through ----
    if (nextTarget >= 2) {
      const trailed = structureStop(candles, i, bullish, cfg.trailLookback);
      if (trailed !== null && better(trailed, pendingStop === null ? stop : pendingStop, bullish)) {
        pendingStop = trailed;
      }
    }

    if (i === limit - 1 && remaining > 0) {
      // Ran out of candles: mark the remainder to market so the trade is not
      // silently dropped from the statistics.
      closeOut(remaining, c.close, 'timeout', i);
      status = highestTargetHit || 'timeout';
      exitBar = i;
    }
  }

  if (!filled) {
    return { filled: false, status: 'expired', rMultiple: 0, exits: [], barsHeld: 0, mfe: 0, mae: 0 };
  }

  return {
    filled: true,
    fillBar,
    status,
    rMultiple: round6(realizedR),
    exits,
    barsHeld: exitBar === null ? limit : exitBar + 1,
    mfe: round6(mfe),
    mae: round6(mae),
    remaining,
  };
}

/** Is `candidate` a tighter (better) stop than `current` for this direction? */
function better(candidate, current, bullish) {
  return bullish ? candidate > current : candidate < current;
}

/**
 * Most recent CONFIRMED swing low (longs) / high (shorts) among the candles
 * seen so far — the level a structure trail sits behind.
 */
function structureStop(candles, upToIndex, bullish, lookback) {
  const window = candles.slice(0, upToIndex + 1);
  const swings = detectSwings(window, lookback);
  const type = bullish ? 'low' : 'high';
  let best = null;
  for (const s of swings) {
    if (s.type !== type) continue;
    if (!best || s.index > best.index) best = s;
  }
  return best ? best.price : null;
}

const round6 = (n) => Number(n.toFixed(6));

module.exports = { simulateTrade, SIMULATOR_DEFAULTS: DEFAULTS };
