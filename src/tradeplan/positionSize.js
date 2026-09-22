'use strict';

const config = require('../config');
const { roundToStep } = require('../util/math');

/**
 * Value of 1.0 unit of the instrument's QUOTE currency in USD.
 *
 *   quote is USD (EUR/USD, Volatility indices) -> 1
 *   base is USD  (USD/JPY, USD/CAD)            -> 1 / price
 *   neither      (GBP/JPY)                     -> live rate if supplied,
 *                                                 otherwise the configured fallback
 */
function quoteToUsd(instrument, price, rates = {}) {
  const quote = instrument.quoteCurrency || 'USD';
  if (quote === 'USD') return { rate: 1, source: 'quote-is-usd' };
  if (instrument.baseCurrency === 'USD') {
    if (!Number.isFinite(price) || price <= 0) return { rate: null, source: 'missing-price' };
    return { rate: 1 / price, source: 'inverse-of-price' };
  }
  if (Number.isFinite(rates[quote])) return { rate: rates[quote], source: 'live-rate' };
  const fallback = config.risk.quoteUsdFallback[quote];
  if (Number.isFinite(fallback)) return { rate: fallback, source: 'configured-fallback' };
  return { rate: null, source: 'unknown-currency' };
}

/**
 * Back-calculate position size from a FIXED dollar risk.
 *
 *   loss per lot (quote ccy) = contractSize * stopDistance
 *   loss per lot (USD)       = loss per lot * quoteToUsd
 *   lots                     = riskUsd / loss per lot (USD), floored to lotStep
 *
 * Flooring means the rounded size never risks MORE than the target. The one
 * exception is a stop so wide that the broker minimum already exceeds the
 * budget — that is reported, not silently accepted.
 */
function calculatePositionSize({ instrument, entryPrice, stopPrice, riskUsd, rates = {} }) {
  const risk = Number.isFinite(riskUsd) ? riskUsd : config.risk.riskPerTrade;
  const stopDistance = Math.abs(entryPrice - stopPrice);
  const warnings = [];

  if (!(stopDistance > 0)) {
    return {
      lots: 0,
      stopDistance: 0,
      valid: false,
      warnings: ['Stop distance is zero — position size cannot be calculated'],
    };
  }

  const { rate, source } = quoteToUsd(instrument, entryPrice, rates);
  if (rate === null) {
    return {
      lots: 0,
      stopDistance,
      valid: false,
      warnings: [`No USD conversion available for ${instrument.quoteCurrency} — position size cannot be calculated`],
    };
  }
  if (source === 'configured-fallback') {
    warnings.push(`${instrument.quoteCurrency}/USD conversion used a configured fallback rate, not a live one`);
  }

  const lossPerLotQuote = instrument.contractSize * stopDistance;
  const lossPerLotUsd = lossPerLotQuote * rate;
  const rawLots = risk / lossPerLotUsd;

  let lots = roundToStep(rawLots, instrument.lotStep, 'floor');
  let belowMinimum = false;

  if (lots < instrument.minLot) {
    belowMinimum = true;
    lots = instrument.minLot;
    warnings.push(
      `Stop is too wide for a $${risk} risk at this account size — sizing at the ${instrument.minLot} lot minimum instead`
    );
  }
  if (lots > instrument.maxLot) {
    lots = instrument.maxLot;
    warnings.push(`Size capped at the ${instrument.maxLot} lot maximum`);
  }

  const actualRiskUsd = lots * lossPerLotUsd;
  if (actualRiskUsd > risk + 1e-9) {
    warnings.push(`Actual risk is $${actualRiskUsd.toFixed(2)}, above the $${risk.toFixed(2)} target`);
  }

  return {
    lots,
    rawLots,
    stopDistance,
    stopDistancePips: stopDistance / instrument.pipSize,
    valuePerLotPerPrice: lossPerLotUsd / stopDistance, // USD per 1.0 price move per lot
    riskPerLotUsd: lossPerLotUsd,
    targetRiskUsd: risk,
    actualRiskUsd,
    quoteUsdRate: rate,
    quoteUsdSource: source,
    belowMinimum,
    valid: true,
    warnings,
  };
}

module.exports = { calculatePositionSize, quoteToUsd };
