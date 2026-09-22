# SMC Alert Bot

Smart Money Concepts trading **alert** bot for Deriv synthetic indices and major forex pairs.
It analyses the market and sends Telegram alerts — it never places or manages trades.

- **HTF bias:** 4H market structure (BOS/CHoCH) + unmitigated order blocks / FVGs
- **Entries:** 30m confirmation scorer, 3-of-6 required to fire
- **Scanning:** every 30m candle close, round the clock, no session restriction
- **Delivery:** formatted Telegram alert, de-duplicated per POI/setup
- **Logging:** every fired alert stored in MongoDB for later win-rate review

See `docs/` and the module docs below once the build is complete.
