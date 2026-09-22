'use strict';

/**
 * Presentation helpers. Every price shown to a human goes through here so an
 * alert never mixes 5-decimal FX prices with 2-decimal synthetic prices.
 */

function precisionFor(instrument) {
  if (instrument && Number.isFinite(instrument.pricePrecision)) return instrument.pricePrecision;
  return null;
}

function formatPrice(value, instrument) {
  if (!Number.isFinite(value)) return '?';
  const p = precisionFor(instrument);
  if (p !== null) return value.toFixed(p);
  // Fallback when no instrument is in scope: more decimals for small prices.
  return Math.abs(value) >= 100 ? value.toFixed(2) : value.toFixed(5);
}

/** A price DISTANCE expressed in pips (forex) or points (synthetics). */
function formatDistance(distance, instrument) {
  if (!Number.isFinite(distance)) return '?';
  const pipSize = instrument && instrument.pipSize ? instrument.pipSize : 1;
  const units = Math.abs(distance) / pipSize;
  const label = instrument && instrument.kind === 'forex' ? 'pips' : 'pts';
  return `${units.toFixed(units >= 100 ? 0 : 1)} ${label}`;
}

function formatMoney(value, currency = '$') {
  if (!Number.isFinite(value)) return '?';
  return `${currency}${value.toFixed(2)}`;
}

function formatLots(value) {
  if (!Number.isFinite(value)) return '?';
  return value >= 1 ? value.toFixed(2) : value.toFixed(3);
}

module.exports = { formatPrice, formatDistance, formatMoney, formatLots, precisionFor };
