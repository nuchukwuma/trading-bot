# SMC Alert Bot

A Smart Money Concepts trading **alert** bot for Deriv synthetic indices (Volatility and Jump)
and major forex pairs — all read from Deriv by default, so one free connection covers everything.
It analyses the market and sends a formatted Telegram alert. **It never places, modifies or closes
an order** — there is no trade endpoint anywhere in the codebase.

- **HTF bias:** 4H market structure (BOS / CHoCH) plus unmitigated order blocks and FVGs
- **Entries:** 30m confirmation scorer — 3 of 6 checks required
- **Scanning:** every 30m candle close, round the clock, no session filter
- **Gating:** a hard 1:2 R:R floor on TP1, then a filter the bot learns and keeps re-learning
- **Growth:** it tracks every setup's outcome and narrows its alerts as evidence accumulates
- **Delivery:** Telegram, de-duplicated per POI/setup
- **Logging:** every fired alert stored in MongoDB with an outcome placeholder for win-rate review

## Quick start

```bash
npm install
cp .env.example .env     # fill in the credentials below
npm test                 # 331 unit tests, no network or database needed
npm run calibrate        # verify symbols and stop buffers against the live feed
npm run backtest         # replay history, measure what works, write the alert filter
npm run scan             # one scan pass, then exit
npm start                # run continuously, scanning on every 30m close
```

Set `DRY_RUN=1` to format and log alerts without sending them to Telegram.

### Credentials

| Variable | What it is |
| --- | --- |
| `DERIV_WS_URL` | Defaults to Deriv's public market-data endpoint `wss://api.derivws.com/trading/v1/options/ws/public`, which needs no account, token or app id — only `ticks_history` is called. The legacy `ws.derivws.com` hosts and app id `1089` are retired and answer HTTP 520. |
| `FOREX_SOURCE` | `deriv` (default) or `oanda`. Deriv needs nothing extra and is available in Nigeria. |
| `OANDA_API_KEY` / `OANDA_ACCOUNT_ID` | Only with `FOREX_SOURCE=oanda`. OANDA practice accounts are not open in every country. |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | From @BotFather, and the chat to post into. |
| `MONGODB_URI` | Where alerts are logged. Set `DB_ENABLED=0` to run without it. |

## Controlling it from Telegram

The bot takes commands in the same chat the alerts go to. Only `TELEGRAM_CHAT_ID` is obeyed;
messages from anyone else are ignored.

| Command | What it does |
| --- | --- |
| `/pairs` | Buttons for every pair — tap to turn its alerts on or off, or All on / All off |
| `/on EURUSD GBPUSD` | Turn pairs on. Names are forgiving: `eurusd`, `EUR/USD`, `vol75` all work |
| `/off VOL75` | Turn pairs off |
| `/only EURUSD GBPUSD` | These pairs and nothing else |
| `/all` | Every pair on |
| `/pause` / `/resume` | Stop / restart all alerts |
| `/status` | Last and next scan, which pairs are on, whether the database is connected |
| `/scan` | Run a scan now |
| `/trades` | Trades running (with live R) or waiting for their entry |
| `/results 30` | How sent alerts played out over the last N days (default 7): wins, R, dollars |
| `/learning` | How many trades it has learned from and what it filters on |

### Following every alert to the end

Every sent alert is followed on each 30m close until it plays out, and the updates arrive as
replies to the original alert — whether you took the trade or not:

- ▶️ **Entry triggered** — price reached the limit entry
- 🎯 **TP1 / TP2 hit** — with what to do next (stop to breakeven, trail) and the running R
- ✅ **Win**, ❌ **Stopped out**, ⏱ **closed at the 48h window** — with the result in R and dollars
- ⚪️ **Invalidated** — the entry was not reached within 8 candles (4h), so there was no trade

The figures assume the plan was followed exactly as sent. They are also what the learner trains on.

### How likely is this setup?

Each alert carries a rating from the bot's own record of similar trades — the same pair at the same
score if there are enough of those, otherwise a wider group (the pair at any score, then the same
market type, then everything):

- 🟢 **High probability** — even the pessimistic end of the 95% range on average R is profitable
- 🟡 **No clear edge yet** — the evidence does not point either way
- 🔴 **Low probability** — even the optimistic end loses
- ⚪️ **Not enough history yet** — fewer than 30 similar resolved trades

The line under it shows the group, how many trades, how many were live, the win rate and average R.

A pair that is off is still scanned and its setups are still tracked and learned from, exactly like
setups the edge profile holds back — you just do not get the message. Choices are saved in MongoDB,
so they survive restarts; without a database they reset when the bot restarts.

Commands use long polling, so no public URL or webhook is needed. Telegram allows only **one**
process per bot token to read commands: if the bot runs on Render and on your computer at the same
time, the second logs an HTTP 409 warning and its commands do not work. Stop one of them, or set
`TELEGRAM_COMMANDS=0` on the copy that should only send alerts.

## How a setup is found

```
4H candles ─► swing detection ─► BOS/CHoCH ─► bias direction
                    │
                    └─► order blocks + FVGs ─► mitigation ─► bias strength

30m candles ─► 6 confirmation checks ─► score ≥ 3 ?
                    │
                    └─► entry / stop / TP ladder ─► TP1 R:R ≥ 1:2 ?
                                │
                                └─► de-dup ─► edge profile ─┬─► Telegram ─► MongoDB
                                              (did setups   │
                                               like this    └─► shadow log (tracked,
                                               actually pay?)    never sent)
                                                     ▲
                                                     │ re-learned as outcomes resolve
                                              ┌──────┴──────┐
                                              │  the ledger │ backtest seed + live results
                                              └─────────────┘
```

The first three gates ask whether a setup is *structurally* valid. The edge profile asks a
different question — whether setups like it have historically made money — and it is the only
one derived from your own data rather than from theory.

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
  distance on a given instrument (`slBuffer` in `src/config/instruments.js`). It is either a number
  of price units, or `{ pct }` as a fixed fraction of the entry price — the latter for indices whose
  level drifts far enough that an absolute buffer goes stale. Neither form reacts to volatility.
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

## How it learns and narrows

The bot starts by alerting everything that clears the structural gates. As outcomes accumulate it
works out which setups actually paid, and alerts shrink to match. On planted-signal data the curve
looks like this — same generator throughout, only the sample size growing:

```
trades  budget  used  rule                      alerts kept  expectancy
50      0       0     (none)                          100%      +0.32R
100     1       1     pattern:double_bottom            40%      +1.40R
400     4       1     pattern:double_bottom            42%      +1.19R
800     4       1     pattern:double_bottom            41%      +1.11R
```

Note it used **one** rule out of a budget of four. More budget does not mean more rules — only more
permission to use one if the evidence is there.

### The three parts

**1. Features — what it can learn about.** Every setup carries a vector of tokens in three families:

| Family | Examples |
| --- | --- |
| `pattern:` / `htf_pattern:` | double top/bottom, head and shoulders, engulfing, pin bar, inside bar, compression, higher lows — on both timeframes |
| `pa:` | break and retest (S-R flip), breaker block, inducement taken, inducement still resting |
| context | `session:london`, `vol:high`, `hour:08-12`, `dow:tue`, `shift:choch`, `poi:fvg`, `sweep:eql`, `rr:2.5-3.5`, `stop:tight`, `bias:strong`, `kind:jump` |

Roughly 70 distinct tokens appear across a typical run.

These are **candidates, not signals**. Nothing in `src/features/` decides anything — the learner
works out from outcomes whether a token carries any edge, and most do not. Adding a new detector
there is all it takes to put a new hypothesis in front of the learner.

A detector is only useful if it *discriminates*: one that fires on 90% of setups splits nothing and
gets dropped as untestable. `pa:break_retest` originally fired on 88% of setups until the retest was
constrained to recent price action; it now sits near 65%, with all four `pa:` tokens in a testable
range.

**2. Outcomes — what it learns from.** Every logged setup is replayed against the candles that
follow it, using the same simulator as the backtest, and resolved to an R multiple. A trade that is
still running stays `pending` rather than being guessed at.

**3. Shadow logging — how it keeps learning after it narrows.** A setup the profile holds back is
still recorded and still resolved; it is simply never sent. Without this the bot would only ever
observe outcomes for trades it already believed in, the filter could never discover it was wrong to
exclude something, and learning would freeze the moment alerts narrowed. Observe everything, alert
little.

### Why it does not invent patterns

Searching ~70 features at once means roughly 3–4 of them will look significant at p&lt;0.05 by pure
chance. Four defences:

| Guard | What it stops |
| --- | --- |
| **Benjamini-Hochberg FDR control** across every feature tested in a run | the multiple-comparisons problem — uncorrected, noise alone produces "patterns" every run |
| **An earned rule budget**: one feature rule per 100 resolved trades, capped at 4 | narrowing hard on thin evidence |
| **Positive lower bounds**, never point estimates | a 70% win rate on 10 trades, whose Wilson bound is 40% |
| **A chronological holdout** the rules are never fitted to | rules that only work on their own training data |
| **Screening on the full training set**, before any score rule narrows it | a starved pool — a score rule can cut the sample by 80%, leaving nothing testable and inviting rules built on a handful of trades |

`tests/harness.test.js` runs the whole feature search over a **random walk** and asserts the rule
set comes back empty. A trending walk is then checked to confirm the guards are not simply blind.

### Watching it grow

```bash
npm run backtest      # seed the ledger and write the first profile
npm start             # from here it resolves outcomes and re-learns on its own
```

The bot re-learns every `LEARN_RELEARN_EVERY` (default 25) new resolved outcomes and logs when the
rules change. `EDGE_PROFILE_REQUIRED=1` keeps it silent until a validated profile exists.

## Backtesting and the edge profile

`npm run backtest` replays history through **the same decision path the live bot uses**
(`src/evaluate.js`), simulates each resulting trade against the candles that followed, and writes
`data/edge-profile.json`. The scanner then enforces that profile before sending anything.

```bash
npm run backtest                  # every enabled instrument
npm run backtest -- VOL75 JUMP75  # just these
npm run backtest -- --no-write    # report only, leave the profile alone
npm run backtest -- --synthetic   # random-walk harness check, not market data
```

### How the trade simulation avoids flattering itself

A 30m candle hides the order of events inside it, and that ambiguity is where backtests go wrong:

- **Stop and target in the same candle → the stop wins.** The optimistic alternative inflates
  every result. Set `BACKTEST_PESSIMISTIC=0` to see the difference; it is large.
- **A stop moved by a target takes effect on the next candle**, so one bar cannot both pay TP1 and
  stop out on the breakeven stop that TP1 created.
- **Unfilled limit entries expire** rather than counting as free wins or losses.
- **Unresolved trades are marked to market**, never dropped from the sample.
- **No look-ahead**: the engines only ever receive candles that had closed. A test replays a prefix
  and then a longer series and asserts every earlier decision is byte-for-byte identical.

Known optimism: a stop is always filled *at* the stop price, so gap-through slippage is not
modelled. That matters most on the Jump indices.

### How the filter is chosen

Selecting the best-looking subset from the data that measured it is how a backtest invents an edge.
Four guards:

1. **Lower bounds, not point estimates.** A bucket qualifies only when the 95% lower bound on its
   expectancy clears zero. A 70% win rate on 10 trades has a Wilson lower bound of 40% — no
   information.
2. **A minimum sample** (`BACKTEST_MIN_SAMPLES`, default 30) before any rule is derived.
3. **At most two mandatory confirmations.** There are 64 subsets of six checks; each extra rule is
   another chance to fit noise.
4. **A chronological holdout.** Rules are chosen on the first 70% and validated once on the last
   30%. The filtered holdout must clear zero *at its lower bound* and beat doing nothing over the
   same period.

A profile that fails validation is written but **not enforced** — rules that only worked on their
own training data are worse than no filter. Override with `EDGE_PROFILE_ENFORCE_UNVALIDATED=1`,
or refuse to alert until a validated profile exists with `EDGE_PROFILE_REQUIRED=1`.

### Is the harness itself honest?

`tests/harness.test.js` replays a **random walk** — data with no structure to find — end to end.
A correct harness must report roughly zero expectancy and refuse to validate any profile. A trending
walk is then checked to confirm the guards are not simply blind to real edge.

This caught a live bug: an earlier selector produced a "validated" profile claiming **+0.48R
out-of-sample on pure noise**. Four guards were missing. The test exists so that cannot return.

### Reading the report

```
bucket                         n     win%    win95%       expR    expR95%     totalR     maxDD
----------------------------------------------------------------------------------------------
all trades                   397    35.8%     31.2%     -0.021     -0.158     -8.139   -48.687
```

`win95%` and `expR95%` are the pessimistic ends of the confidence intervals — the only columns the
selector ranks on. Buckets are reported by score, instrument, bias strength, direction, POI kind,
outcome and individual confirmation.

## Instruments

| Group | Instruments | Source |
| --- | --- | --- |
| Volatility indices | Vol 50, Vol 75 | Deriv WebSocket |
| Jump indices | Jump 10, 25, 50, 75, 100 | Deriv WebSocket |
| Forex majors | EUR/USD, GBP/USD, USD/JPY, AUD/USD, USD/CAD, GBP/JPY | Deriv (`frx*`) by default, or OANDA |

Restrict a run with `INSTRUMENTS=JUMP75,EURUSD`, or drop one permanently with `enabled: false`.

### Forex data and your broker

Forex candles come from Deriv's own feed by default. **Exness, and other brokers that are MT4/MT5
only, publish no candle API** — there is nothing for the bot to connect to without running an MT5
terminal and a bridge, so they cannot be a source directly.

That is fine for analysis. Market structure, order blocks and FVGs on 30m and 4H read the same
across feeds. What *can* differ is the exact wick extreme, by a few points, because each broker
quotes its own liquidity. The sweep detector is wick-sensitive, so if you execute on Exness,
check the level on your own chart before entering — the alert's levels are Deriv's.

**Forex closes at the weekend; the synthetics do not.** The scanner handles that without
special-casing: no new candle means no new setup. Outcome tracking counts its review window in
candles rather than clock hours, so a Friday setup is not resolved on Monday against a handful of
candles just because 48 hours passed.

### Jump indices

Jump indices tick like the volatility indices but add a discrete **jump** roughly three times an
hour, each around 30x a normal tick move. Two of those consequences are mechanical artefacts of the
jump process rather than anything institutional, so each Jump instrument carries engine overrides:

| Override | Default | Jump | Why |
| --- | --- | --- | --- |
| `displacement.bodyMultiple` | 1.5 | 2.5 | A 30m candle containing a jump has a huge body, so the normal bar fires on almost every jump |
| `poi.fvg.minGapFactor` | 0.1 | 0.35 | Jumps leave three-candle gaps by themselves, which are not imbalance in the SMC sense |

Any instrument can carry an `engine: { ... }` block; the scanner merges it over the global config
one level deep, so a single threshold can be overridden without restating its section.

**A jump can gap straight through the stop.** No buffer width prevents that, and it is the main
reason to treat alerts on these indices more cautiously than the volatility ones.

The Jump entries are marked `calibrated: false` because their symbols, price levels and lot
constraints have not been checked against a live feed. `npm run calibrate` confirms every symbol
exists, reports the recent 30m range distribution and suggests a stop buffer:

```
30m candle ranges and stop buffer suggestions

instrument  price         median        p90           suggested     configured    as pct
------------------------------------------------------------------------------------------------
JUMP75      99412.8300    284.1500      611.2200      142.0750      149.1192      0.1429%
```

It never runs during a scan — it only helps you choose the constant. Until then the bot warns at
startup that those numbers are estimates.

## Deploying to Render (free web service)

`render.yaml` sets the bot up as a free **web service**. Render only keeps a web service running
if it listens on a port, so when `PORT` is set the bot also starts a small HTTP server:

- `GET /healthz` returns `ok` (Render's health check)
- `GET /` returns status JSON: instruments, last scan, next scan, scan count

**Keeping it awake.** Render puts a free web service to sleep after 15 minutes with no incoming
requests. A sleeping bot does not scan. To prevent that, the bot pings its own public URL
(`RENDER_EXTERNAL_URL`, which Render sets) every `KEEP_AWAKE_MINUTES` (default 10). The request
goes out through Render's proxy and back in, so it counts as incoming traffic.

| Variable | Default | Meaning |
| --- | --- | --- |
| `KEEP_AWAKE` | `1` | Set `0` to turn self-pinging off |
| `KEEP_AWAKE_HOURS` | empty (all day) | e.g. `6-22` = ping only from 06:00 to 22:00; `22-6` wraps overnight |
| `KEEP_AWAKE_TZ` | `Africa/Lagos` | Time zone the hours are read in |
| `KEEP_AWAKE_MINUTES` | `10` | Ping interval. Keep it under 15 |
| `KEEP_AWAKE_URL` | `RENDER_EXTERNAL_URL` | Override the URL that gets pinged |

**A bot that is asleep cannot wake itself.** Self-pinging keeps it awake, but if it does fall asleep
(after a window ends, or after a restart that is never followed by a request) something outside
has to send it a request. Add a free external monitor such as UptimeRobot or cron-job.org that
requests `https://<your-service>.onrender.com/healthz` every 5–10 minutes. With a window, have it
start a few minutes before the window opens. The bot wakes within about a minute of the first
request and scans at the next 30m close.

**Limits to know about:**
- The free tier gives 750 instance hours a month per workspace. Running all day uses about
  720–744, so this has to be the only free service on the account that stays awake. A `6-22` window
  uses about 500.
- The free tier's disk is wiped on every restart, deploy or wake. MongoDB (for example a free Atlas
  cluster) keeps alerts and outcomes, but `data/edge-profile.json` and
  `data/backtest-trades.json` do not survive. After a restart the bot alerts unfiltered until the
  learner re-runs.

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
  features/    chart-pattern and context extraction — the learner's candidate hypotheses
  learn/       the learner, outcome tracking, trade ledger, growth loop
  backtest/    trade simulator, walk-forward replay, statistics, profile selection
  evaluate.js  the single decision path shared by the live scanner and the backtest
  scanner.js   the per-instrument pipeline
  server.js    status/health HTTP server and keep-awake pinger (Render)
  control/     Telegram commands and the per-pair on/off settings
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
minimum confirmations, the R:R floor and the TP ladder. Per-instrument stop buffers, lot
constraints and engine overrides live in `src/config/instruments.js`.
