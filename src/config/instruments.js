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
 *   slBuffer    FIXED stop-loss buffer beyond the sweep wick / order block edge.
 *               Either a NUMBER of price units, or { pct } as a fixed fraction
 *               of the entry price. Both are constants per instrument — neither
 *               reacts to volatility, so the stop is never ATR-scaled.
 *               Use { pct } when the index level drifts far over time, so the
 *               buffer does not quietly become too tight or too wide.
 *   engine      optional per-instrument engine overrides, merged over the global
 *               config by the scanner (see mergeEngineOpts in src/scanner.js).
 *   calibrated  false means the sizing/buffer fields are estimates that have not
 *               been checked against a live feed. Run `npm run calibrate`.
 *   minLot/lotStep/maxLot broker sizing constraints used when back-calculating size.
 */

/**
 * Jump indices tick like the volatility indices but add a discrete JUMP roughly
 * three times an hour, each around 30x a normal tick move. Two consequences the
 * engine has to be told about, since both are mechanical artefacts of the jump
 * process rather than anything institutional:
 *
 *   - a 30m candle containing a jump has a huge body, so the 1.5x displacement
 *     bar fires far too easily -> raised to 2.5x
 *   - jumps leave three-candle gaps on their own -> the minimum FVG size is
 *     raised so only substantial imbalances are tracked
 *
 * A jump can also gap straight through a stop: no buffer width prevents that.
 */
const JUMP_ENGINE = {
  displacement: { bodyMultiple: 2.5 },
  poi: {
    fvg: { minGapFactor: 0.35 },
    orderBlocks: { displacementBodyMultiple: 2.5 },
  },
};

/**
 * Buffer as a fraction of price, scaled by the volatility number in the
 * instrument's name. Anchored on Volatility 75, where 150 price units at an
 * index level around 100k is ~0.15%.
 */
const jumpBuffer = (volatility) => ({ pct: 0.002 * (volatility / 100) });

/**
 * Forex data source.
 *
 *   deriv (default)  Deriv's own forex feed via the WebSocket connector the
 *                    synthetics already use: no extra account or API key, and
 *                    available in Nigeria.
 *   oanda            OANDA v20 REST. Needs an OANDA practice account, which is
 *                    not open to every country.
 *
 * Brokers like Exness are MT4/MT5-only and publish no candle API, so they
 * cannot be a source here directly. Structure on 30m/4H reads the same across
 * feeds; exact wick extremes can differ by a few points between brokers.
 */
const FOREX_SOURCES = ['deriv', 'oanda'];

function resolveForexSource(instrument, source = process.env.FOREX_SOURCE || 'deriv') {
  const chosen = String(source).toLowerCase();
  if (!FOREX_SOURCES.includes(chosen)) {
    throw new Error(`FOREX_SOURCE must be one of ${FOREX_SOURCES.join(', ')} — got "${source}"`);
  }
  return { ...instrument, source: chosen, symbol: instrument.symbols[chosen] };
}

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

  // ---------------- Deriv Jump indices ----------------
  // Symbols follow Deriv's JD<volatility> convention. Verify them, and the lot
  // constraints below, with `npm run calibrate` before trading these.
  ...[10, 25, 50, 75, 100].map((volatility) => ({
    id: `JUMP${volatility}`,
    displayName: `Jump ${volatility} Index`,
    source: 'deriv',
    symbol: `JD${volatility}`,
    kind: 'synthetic',
    subKind: 'jump',
    quoteCurrency: 'USD',
    pipSize: 1,
    pricePrecision: 4,
    contractSize: 1,
    slBuffer: jumpBuffer(volatility),
    minLot: 0.01,
    lotStep: 0.01,
    maxLot: 50,
    engine: JUMP_ENGINE,
    calibrated: false,
    enabled: true,
  })),

  // ---------------- Forex majors ----------------
  // Each pair carries a symbol for every supported feed; FOREX_SOURCE picks
  // which one is live (see resolveForexSource below).
  ...[
    // id       base   quote  pip     prec  slBuffer
    ['EURUSD', 'EUR', 'USD', 0.0001, 5, 0.0006],
    ['GBPUSD', 'GBP', 'USD', 0.0001, 5, 0.0008],
    ['USDJPY', 'USD', 'JPY', 0.01, 3, 0.08],
    ['AUDUSD', 'AUD', 'USD', 0.0001, 5, 0.0006],
    ['USDCAD', 'USD', 'CAD', 0.0001, 5, 0.0007],
    ['GBPJPY', 'GBP', 'JPY', 0.01, 3, 0.14],
  ].map(([id, base, quote, pipSize, pricePrecision, slBuffer]) =>
    resolveForexSource({
      id,
      displayName: `${base}/${quote}`,
      kind: 'forex',
      baseCurrency: base,
      quoteCurrency: quote,
      symbols: {
        deriv: `frx${base}${quote}`,
        oanda: `${base}_${quote}`,
      },
      pipSize,
      pricePrecision,
      contractSize: 100000,
      slBuffer,
      minLot: 0.01,
      lotStep: 0.01,
      maxLot: 100,
      // Forex, unlike the synthetics, closes at the weekend.
      marketHours: 'forex',
      enabled: true,
    })
  ),
];

function byId(id) {
  return INSTRUMENTS.find((i) => i.id === id);
}

function enabledInstruments(filterIds) {
  const ids = (filterIds || []).map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (ids.length === 0) return INSTRUMENTS.filter((i) => i.enabled);
  return INSTRUMENTS.filter((i) => ids.includes(i.id));
}

module.exports = { INSTRUMENTS, byId, enabledInstruments, resolveForexSource, FOREX_SOURCES };
