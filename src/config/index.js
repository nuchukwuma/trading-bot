'use strict';

require('dotenv').config();

const { INSTRUMENTS, byId, enabledInstruments } = require('./instruments');

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));

const config = {
  env: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',
  dryRun: bool(process.env.DRY_RUN, false),

  // ---------------- Timeframes ----------------
  timeframes: {
    htf: '4h', // bias
    ltf: '30m', // entries
    htfSeconds: 4 * 60 * 60,
    ltfSeconds: 30 * 60,
    // How much history each engine needs.
    htfCandles: num(process.env.HTF_CANDLES, 300),
    ltfCandles: num(process.env.LTF_CANDLES, 400),
  },

  // ---------------- Structure engine ----------------
  structure: {
    // Fractal lookback: a swing high needs `swingLookback` lower highs on each side.
    swingLookback: num(process.env.SWING_LOOKBACK, 2),
    // A structural break needs a CLOSE beyond the swing, not just a wick.
    breakOnClose: bool(process.env.BREAK_ON_CLOSE, true),
    // Ignore breaks smaller than this fraction of the average range (noise filter).
    minBreakAtrFactor: num(process.env.MIN_BREAK_ATR_FACTOR, 0),
  },

  // ---------------- POI tracking ----------------
  poi: {
    maxTracked: num(process.env.POI_MAX_TRACKED, 10), // keep 5-10 most recent HTF POIs
    minTracked: num(process.env.POI_MIN_TRACKED, 5),
    // A POI is "mitigated" once price trades through this fraction of the zone.
    mitigationFillRatio: num(process.env.POI_MITIGATION_FILL, 0.5),
    // POIs older than this many candles are dropped.
    maxAgeCandles: num(process.env.POI_MAX_AGE_CANDLES, 120),
    // "approaching" = within this many zone-heights of the proximal edge.
    approachZoneMultiple: num(process.env.POI_APPROACH_MULTIPLE, 1.5),
  },

  // ---------------- Liquidity ----------------
  liquidity: {
    // Two swings are "equal" when within this fraction of the average range.
    equalLevelAtrFactor: num(process.env.EQ_LEVEL_ATR_FACTOR, 0.1),
    // How far back (candles) a sweep may have happened before the shift.
    sweepLookback: num(process.env.SWEEP_LOOKBACK, 12),
    // Wick sweep: wick must pierce the level and the body must close back inside.
    minWickBodyRatio: num(process.env.MIN_WICK_BODY_RATIO, 1.0),
  },

  // ---------------- Displacement ----------------
  displacement: {
    avgPeriod: num(process.env.DISPLACEMENT_AVG_PERIOD, 20),
    bodyMultiple: num(process.env.DISPLACEMENT_BODY_MULTIPLE, 1.5),
    lookback: num(process.env.DISPLACEMENT_LOOKBACK, 5),
  },

  // ---------------- Premium / discount ----------------
  premiumDiscount: {
    // Equilibrium is the 50% of the dealing range.
    equilibrium: 0.5,
    // Range is measured over the most recent N candles of the LTF leg.
    rangeLookback: num(process.env.PD_RANGE_LOOKBACK, 60),
  },

  // ---------------- Scoring ----------------
  scoring: {
    minConfirmations: num(process.env.MIN_CONFIRMATIONS, 3),
    totalChecks: 6,
  },

  // ---------------- Trade plan ----------------
  tradePlan: {
    // Hard gate — no alert if TP1 R:R is under this.
    minRiskReward: num(process.env.MIN_RR, 2),
    targets: [
      { name: 'TP1', rr: num(process.env.TP1_RR, 2), closePct: 50, moveStopToBreakeven: true },
      { name: 'TP2', rr: num(process.env.TP2_RR, 3.5), closePct: 30, trailToStructure: true },
      { name: 'TP3', rr: num(process.env.TP3_RR, 5), closePct: 20, useLiquidityPoolIfCloser: true },
    ],
    // Entry is placed at the optimal edge of the POI (proximal edge by default).
    entryMode: process.env.ENTRY_MODE || 'edge', // 'edge' | 'mid'
  },

  // ---------------- Risk ----------------
  risk: {
    accountBalance: num(process.env.ACCOUNT_BALANCE, 10),
    riskPerTrade: num(process.env.RISK_PER_TRADE, 3), // fixed $ risk
    // Static fallbacks for converting a non-USD quote currency into USD when no
    // live cross rate is supplied by the data layer.
    quoteUsdFallback: {
      USD: 1,
      JPY: 1 / 150,
      CAD: 1 / 1.36,
      CHF: 1 / 0.88,
      AUD: 0.66,
      NZD: 0.6,
      GBP: 1.27,
      EUR: 1.08,
    },
  },

  // ---------------- Alerts ----------------
  alerts: {
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN || '',
      chatId: process.env.TELEGRAM_CHAT_ID || '',
      apiUrl: process.env.TELEGRAM_API_URL || 'https://api.telegram.org',
      parseMode: 'HTML',
    },
    dedup: {
      // Same instrument + direction + POI cannot re-fire inside this window.
      ttlMinutes: num(process.env.DEDUP_TTL_MINUTES, 240),
      maxEntries: num(process.env.DEDUP_MAX_ENTRIES, 500),
      // Entry prices within this fraction of the stop distance count as the same setup.
      priceTolerance: num(process.env.DEDUP_PRICE_TOLERANCE, 0.25),
    },
  },

  // ---------------- Data sources ----------------
  data: {
    deriv: {
      appId: process.env.DERIV_APP_ID || '1089',
      wsUrl: process.env.DERIV_WS_URL || 'wss://ws.derivws.com/websockets/v3',
      requestTimeoutMs: num(process.env.DERIV_TIMEOUT_MS, 20000),
      reconnectDelayMs: num(process.env.DERIV_RECONNECT_MS, 3000),
      maxReconnectDelayMs: num(process.env.DERIV_MAX_RECONNECT_MS, 60000),
    },
    oanda: {
      apiKey: process.env.OANDA_API_KEY || '',
      accountId: process.env.OANDA_ACCOUNT_ID || '',
      apiUrl: process.env.OANDA_API_URL || 'https://api-fxpractice.oanda.com',
      // OANDA candles: M(id)price 'M' = midpoint.
      price: process.env.OANDA_PRICE || 'M',
      requestTimeoutMs: num(process.env.OANDA_TIMEOUT_MS, 20000),
    },
  },

  // ---------------- Persistence ----------------
  db: {
    uri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/smc-alert-bot',
    enabled: bool(process.env.DB_ENABLED, true),
  },

  // ---------------- Scheduler ----------------
  scheduler: {
    // Scan on every 30m candle close, round the clock. No session restriction.
    intervalSeconds: num(process.env.SCAN_INTERVAL_SECONDS, 30 * 60),
    // Wait after the candle closes so the feed has published the closed candle.
    closeDelaySeconds: num(process.env.SCAN_CLOSE_DELAY_SECONDS, 15),
    scanOnStart: bool(process.env.SCAN_ON_START, true),
  },

  instruments: enabledInstruments((process.env.INSTRUMENTS || '').split(',')),
  allInstruments: INSTRUMENTS,
  instrumentById: byId,
};

module.exports = config;
