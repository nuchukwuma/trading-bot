# SMC Alert Bot

A Smart Money Concepts trading **alert** bot for Deriv synthetic indices and major forex pairs.
It analyses the market and sends a formatted Telegram alert. **It never places, modifies or closes
an order** — there is no trade endpoint anywhere in the codebase.

- **HTF bias:** 4H market structure (BOS / CHoCH) plus unmitigated order blocks and FVGs
- **Entries:** 30m confirmation scorer — 3 of 6 checks required
- **Scanning:** every 30m candle close, round the clock, no session filter
- **Gating:** a hard 1:2 R:R floor on TP1 that no confirmation score can override
- **Delivery:** Telegram, de-duplicated per POI/setup
- **Logging:** every fired alert stored in MongoDB with an outcome placeholder for win-rate review

## Quick start

```bash
npm install
cp .env.example .env     # fill in the credentials below
npm test                 # 165 unit tests, no network or database needed
npm run scan             # one scan pass, then exit
npm start                # run continuously, scanning on every 30m close
```

Set `DRY_RUN=1` to format and log alerts without sending them to Telegram.

### Credentials

| Variable | What it is |
| --- | --- |
| `DERIV_APP_ID` | Deriv app id from https://api.deriv.com. `1089` is the public demo id. No API token is needed — only `ticks_history` is called. |
| `OANDA_API_KEY` / `OANDA_ACCOUNT_ID` | OANDA v20 practice account (free). Clean candles, generous limits. Only `/candles` is called. |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | From @BotFather, and the chat to post into. |
| `MONGODB_URI` | Where alerts are logged. Set `DB_ENABLED=0` to run without it. |

## How a setup is found

```
4H candles ─► swing detection ─► BOS/CHoCH ─► bias direction
                    │
                    └─► order blocks + FVGs ─► mitigation ─► bias strength

30m candles ─► 6 confirmation checks ─► score ≥ 3 ?
                    │
                    └─► entry / stop / TP ladder ─► TP1 R:R ≥ 1:2 ?
                                │
                                └─► de-dup ─► Telegram ─► MongoDB
```

### HTF bias (4H)

Direction is the 4H structure direction and nothing overrides it. Strength is then adjusted by
where price sits against the tracked unmitigated 4H POIs (the 5–10 most recent):

| Situation | Effect |
| --- | --- |
| Price reacting inside an unmitigated POI that agrees with the bias | +1.0 |
| Price approaching one | +0.5 |
| Price inside an unmitigated POI that opposes the bias | −1.0 |
| Price approaching an opposing POI | −0.5 |

Score 0–3 maps to weak / moderate / strong.

### The six 30m confirmations

| # | Check | Fires when |
| --- | --- | --- |
| 1 | `ltf_structure` | The latest 30m BOS/CHoCH matches the 4H bias and is not stale |
| 2 | `liquidity_sweep` | EQH/EQL or a single-candle wick sweep took liquidity before the shift |
| 3 | `poi_retrace` | Price is trading inside an unmitigated 30m order block or FVG |
| 4 | `premium_discount` | Entry is in discount (longs) / premium (shorts) of the 50% dealing range |
| 5 | `htf_confluence` | The 30m entry zone overlaps an unmitigated 4H POI |
| 6 | `displacement` | A candle with a body ≥ 1.5× the 20-period average range drove the move |

Each fired check returns a one-line human-readable reason, and every reason travels into the alert.

### Trade plan

- **Entry** — the POI edge price meets first, never a level price has already traded through.
- **Stop** — a *fixed* per-instrument buffer beyond the sweep wick or the POI's far edge, whichever
  is further from entry. Deliberately **not** ATR-scaled, so the same setup always risks the same
  distance on a given instrument (`slBuffer` in `src/config/instruments.js`).
- **Targets** — 1:2 / 1:3.5 / 1:5, closing 50% / 30% / 20%. Stop to breakeven after TP1, trail
  behind 30m structure after TP2. Each target is capped at the nearest obstacle ahead — untapped
  liquidity or an unmitigated opposing 4H POI — which is what gives TP3 its "next major liquidity
  pool if closer" behaviour.
- **Hard gate** — if capping drags TP1's real R:R below 1:2, the setup is discarded and no alert
  fires, whatever the confirmation score.
- **Size** — back-calculated from a fixed $3 risk on a $10 account, always floored to the lot step
  so rounding never over-risks. A stop too wide for the budget is flagged in the alert rather than
  silently accepted.

Position sizing accounts for how each instrument actually prices a move:

```
loss per lot (quote ccy) = contractSize × stopDistance
loss per lot (USD)       = loss per lot × quoteToUsd
lots                     = riskUsd ÷ loss per lot (USD)    [floored to lotStep]
```

`quoteToUsd` is 1 for USD-quoted instruments (EUR/USD, the volatility indices), `1/price` for
USD-based pairs (USD/JPY, USD/CAD), and a live or configured cross rate otherwise (GBP/JPY).

### De-duplication

An alert is suppressed when a recent one matches the same instrument + direction and either the
same POI id, or an entry within 25% of the stop distance. Entries expire after `DEDUP_TTL_MINUTES`
(4h by default) and the window is re-seeded from MongoDB on restart, so a restart does not replay
alerts that already went out.

## Layout

```
src/
  config/      all tunable constants — timeframes, thresholds, instruments, risk params
  structure/   swing detection, BOS/CHoCH, displacement, dealing range, HTF bias
  poi/         order block + FVG detection and mitigation tracking
  liquidity/   EQH/EQL clustering, wick sweeps, next untapped liquidity pool
  scoring/     the six confirmation checks and the scorer
  tradeplan/   entry/SL/TP calculation, R:R gate, position sizing, partial TP logic
  data/        Deriv WebSocket + OANDA REST connectors, candle aggregation
  alerts/      Telegram client, alert formatting, de-duplication
  db/          MongoDB models and logging
  scanner.js   the per-instrument pipeline
  index.js     scheduler and entry point
tests/         unit tests per module
```

## Reviewing performance later

Every fired alert is stored with `outcome.status = 'pending'`. Fill it in afterwards:

```js
const db = require('./src/db');
await db.connect();
await db.recordOutcome(alertId, { status: 'tp2', rMultiple: 3.5, notes: 'ran clean' });
console.log(await db.performanceSummary());
```

`performanceSummary()` groups by instrument and outcome with average R and average confirmation
score, so you can see whether a higher score actually converts better.

## Tuning

Everything adjustable lives in `src/config/index.js` and is overridable by environment variable —
swing lookback, break-on-close, mitigation fill ratio, sweep lookback, displacement multiple,
minimum confirmations, the R:R floor and the TP ladder. Per-instrument stop buffers and lot
constraints live in `src/config/instruments.js`.
