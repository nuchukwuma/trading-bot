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
    // A 30m structural shift older than this many candles is stale.
    maxEventAgeCandles: num(process.env.MAX_EVENT_AGE_CANDLES, 10),
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
      // Pasted values often carry spaces, quotes or a "bot" prefix copied from
      // the API URL; any of those makes Telegram answer 401.
      botToken: String(process.env.TELEGRAM_BOT_TOKEN || '')
        .trim()
        .replace(/^['"]|['"]$/g, '')
        .replace(/^bot(?=\d)/, ''),
      chatId: String(process.env.TELEGRAM_CHAT_ID || '')
        .trim()
        .replace(/^['"]|['"]$/g, ''),
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
      // Deriv retired the legacy ws.derivws.com / ws.binaryws.com hosts (they
      // now answer HTTP 520). Market data comes from the public endpoint,
      // which needs no login and no app id.
      appId: process.env.DERIV_APP_ID || '',
      wsUrl: process.env.DERIV_WS_URL || 'wss://api.derivws.com/trading/v1/options/ws/public',
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

  // ---------------- Learned edge profile ----------------
  edge: {
    // Written by `npm run backtest`, read by the scanner before alerting.
    profilePath: process.env.EDGE_PROFILE_PATH || 'data/edge-profile.json',
    // Refuse to alert at all until a validated profile exists.
    required: bool(process.env.EDGE_PROFILE_REQUIRED, false),
    // Enforce a profile that failed its out-of-sample check. Off by default:
    // rules that only worked on the data they were fitted to are worse than
    // no filter at all.
    enforceUnvalidated: bool(process.env.EDGE_PROFILE_ENFORCE_UNVALIDATED, false),
  },

  // ---------------- Learning ----------------
  learn: {
    // Seed trades written by `npm run backtest`, pooled with live outcomes.
    seedPath: process.env.LEARN_SEED_PATH || 'data/backtest-trades.json',
    // Re-run the learner once this many new outcomes have resolved.
    relearnEvery: num(process.env.LEARN_RELEARN_EVERY, 25),
    // Bars a live setup is tracked for before it is marked out.
    maxBars: num(process.env.LEARN_MAX_BARS, 96),
    // One feature rule earned per this many resolved trades.
    tradesPerRule: num(process.env.LEARN_TRADES_PER_RULE, 100),
    maxFeatureRules: num(process.env.LEARN_MAX_FEATURE_RULES, 4),
    minSamples: num(process.env.LEARN_MIN_SAMPLES, 30),
    trainRatio: num(process.env.LEARN_TRAIN_RATIO, 0.7),
    fdr: num(process.env.LEARN_FDR, 0.1),
    maxLedgerTrades: num(process.env.LEARN_MAX_LEDGER, 20000),
    // Log setups the profile held back, so learning keeps covering the full
    // distribution instead of only what the bot already believes in.
    shadowLogging: bool(process.env.LEARN_SHADOW_LOGGING, true),
    enabled: bool(process.env.LEARN_ENABLED, true),
  },

  // ---------------- Backtest ----------------
  backtest: {
    candles: num(process.env.BACKTEST_CANDLES, 5000),
    warmupBars: num(process.env.BACKTEST_WARMUP_BARS, 120),
    tailBars: num(process.env.BACKTEST_TAIL_BARS, 96),
    maxBars: num(process.env.BACKTEST_MAX_BARS, 96),
    minSamples: num(process.env.BACKTEST_MIN_SAMPLES, 30),
    trainRatio: num(process.env.BACKTEST_TRAIN_RATIO, 0.7),
    pessimistic: bool(process.env.BACKTEST_PESSIMISTIC, true),
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

  // ---------------- Web service (Render) ----------------
  server: {
    // Render and Replit set PORT. The server always runs outside `--once`.
    port: num(process.env.PORT, 3000),
    keepAwake: {
      enabled: bool(process.env.KEEP_AWAKE, true),
      // Render sets RENDER_EXTERNAL_URL itself; KEEP_AWAKE_URL overrides it.
      url: process.env.KEEP_AWAKE_URL || process.env.RENDER_EXTERNAL_URL || '',
      // Must stay under Render's 15 minute idle limit.
      intervalMinutes: num(process.env.KEEP_AWAKE_MINUTES, 10),
      // "6-22" = 06:00 to 22:00 in KEEP_AWAKE_TZ. Empty = all day.
      hours: process.env.KEEP_AWAKE_HOURS || '',
      tz: process.env.KEEP_AWAKE_TZ || 'Africa/Lagos',
    },
  },

  instruments: enabledInstruments((process.env.INSTRUMENTS || '').split(',')),
  allInstruments: INSTRUMENTS,
  instrumentById: byId,
};

module.exports = config;
