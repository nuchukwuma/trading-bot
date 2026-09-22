'use strict';

/**
 * Instrument registry.
 *
 * Price maths vocabulary used across the bot:
 *   pipSize     price movement equal to "1 pip" (forex) or "1 point" (synthetics).
 *               Used only for human readable distances.
 *   contractSize value, in the QUOTE currency, of a 1.0 price move for 1.0 lot.
 *               EUR/USD: 100_000 -> 1.0 lot, 0.0001 move = 10 quote units = $10/pip.
 *               Volatility indices: 1 -> 1.0 lot, 1.0 point move = $1.
 *   slBuffer    FIXED stop-loss buffer beyond the sweep wick / order block edge,
 *               expressed in PRICE units (deliberately not ATR-scaled).
 *   minLot/lotStep/maxLot broker sizing constraints used when back-calculating size.
 */

const INSTRUMENTS = [
  // ---------------- Deriv synthetic indices ----------------
  {
    id: 'VOL50',
    displayName: 'Volatility 50 Index',
    source: 'deriv',
    symbol: 'R_50',
    kind: 'synthetic',
    quoteCurrency: 'USD',
    pipSize: 1,
    pricePrecision: 4,
    contractSize: 1,
    slBuffer: 25,
    minLot: 0.001,
    lotStep: 0.001,
    maxLot: 50,
    enabled: true,
  },
  {
    id: 'VOL75',
    displayName: 'Volatility 75 Index',
    source: 'deriv',
    symbol: 'R_75',
    kind: 'synthetic',
    quoteCurrency: 'USD',
    pipSize: 1,
    pricePrecision: 4,
    contractSize: 1,
    slBuffer: 150,
    minLot: 0.001,
    lotStep: 0.001,
    maxLot: 50,
    enabled: true,
  },

  // ---------------- Forex majors (OANDA) ----------------
  {
    id: 'EURUSD',
    displayName: 'EUR/USD',
    source: 'oanda',
    symbol: 'EUR_USD',
    kind: 'forex',
    baseCurrency: 'EUR',
    quoteCurrency: 'USD',
    pipSize: 0.0001,
    pricePrecision: 5,
    contractSize: 100000,
    slBuffer: 0.0006,
    minLot: 0.01,
    lotStep: 0.01,
    maxLot: 100,
    enabled: true,
  },
  {
    id: 'GBPUSD',
    displayName: 'GBP/USD',
    source: 'oanda',
    symbol: 'GBP_USD',
    kind: 'forex',
    baseCurrency: 'GBP',
    quoteCurrency: 'USD',
    pipSize: 0.0001,
    pricePrecision: 5,
    contractSize: 100000,
    slBuffer: 0.0008,
    minLot: 0.01,
    lotStep: 0.01,
    maxLot: 100,
    enabled: true,
  },
  {
    id: 'USDJPY',
    displayName: 'USD/JPY',
    source: 'oanda',
    symbol: 'USD_JPY',
    kind: 'forex',
    baseCurrency: 'USD',
    quoteCurrency: 'JPY',
    pipSize: 0.01,
    pricePrecision: 3,
    contractSize: 100000,
    slBuffer: 0.08,
    minLot: 0.01,
    lotStep: 0.01,
    maxLot: 100,
    enabled: true,
  },
  {
    id: 'AUDUSD',
    displayName: 'AUD/USD',
    source: 'oanda',
    symbol: 'AUD_USD',
    kind: 'forex',
    baseCurrency: 'AUD',
    quoteCurrency: 'USD',
    pipSize: 0.0001,
    pricePrecision: 5,
    contractSize: 100000,
    slBuffer: 0.0006,
    minLot: 0.01,
    lotStep: 0.01,
    maxLot: 100,
    enabled: true,
  },
  {
    id: 'USDCAD',
    displayName: 'USD/CAD',
    source: 'oanda',
    symbol: 'USD_CAD',
    kind: 'forex',
    baseCurrency: 'USD',
    quoteCurrency: 'CAD',
    pipSize: 0.0001,
    pricePrecision: 5,
    contractSize: 100000,
    slBuffer: 0.0007,
    minLot: 0.01,
    lotStep: 0.01,
    maxLot: 100,
    enabled: true,
  },
  {
    id: 'GBPJPY',
    displayName: 'GBP/JPY',
    source: 'oanda',
    symbol: 'GBP_JPY',
    kind: 'forex',
    baseCurrency: 'GBP',
    quoteCurrency: 'JPY',
    pipSize: 0.01,
    pricePrecision: 3,
    contractSize: 100000,
    slBuffer: 0.14,
    minLot: 0.01,
    lotStep: 0.01,
    maxLot: 100,
    enabled: true,
  },
];

function byId(id) {
  return INSTRUMENTS.find((i) => i.id === id);
}

function enabledInstruments(filterIds) {
  const ids = (filterIds || []).map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (ids.length === 0) return INSTRUMENTS.filter((i) => i.enabled);
  return INSTRUMENTS.filter((i) => ids.includes(i.id));
}

module.exports = { INSTRUMENTS, byId, enabledInstruments };
