#!/usr/bin/env node
'use strict';

/**
 * Calibration helper.
 *
 * The stop buffer stays a FIXED constant per instrument at runtime — this
 * script never runs during a scan. It only helps you choose that constant
 * once, from real candles, instead of guessing:
 *
 *   1. confirms every Deriv symbol in the registry exists on the feed
 *   2. reports the recent 30m range distribution per instrument
 *   3. suggests a stop buffer, and shows what the configured one resolves to
 *
 * Usage:  npm run calibrate            (every enabled instrument)
 *         npm run calibrate -- JUMP75  (just these)
 */

const config = require('../src/config');
const { DerivConnector } = require('../src/data/derivConnector');
const { OandaConnector } = require('../src/data/oandaConnector');
const { resolveStopBuffer } = require('../src/tradeplan');
const { range } = require('../src/util/candles');
const { formatPrice } = require('../src/util/format');

const percentile = (sorted, p) => {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx];
};

async function main() {
  const filter = process.argv.slice(2).map((s) => s.toUpperCase());
  const instruments = config.allInstruments.filter(
    (i) => i.enabled && (filter.length === 0 || filter.includes(i.id))
  );

  const deriv = new DerivConnector();
  const oanda = new OandaConnector();
  const needsDeriv = instruments.some((i) => i.source === 'deriv');

  // ---- 1. symbol check -------------------------------------------------
  let known = null;
  if (needsDeriv) {
    try {
      const symbols = await deriv.fetchActiveSymbols();
      known = new Map(symbols.map((s) => [s.symbol, s.display_name]));
      console.log(`\nDeriv feed reports ${symbols.length} tradeable symbols.\n`);

      const jumps = symbols.filter((s) => /jump/i.test(s.display_name || ''));
      if (jumps.length) {
        console.log('Jump indices on the feed:');
        for (const s of jumps) console.log(`  ${s.symbol.padEnd(10)} ${s.display_name}`);
        console.log('');
      }

      const forex = symbols.filter((s) => /^frx/.test(s.symbol));
      if (forex.length) {
        console.log(`Forex pairs on the feed (${forex.length}):`);
        console.log(`  ${forex.map((s) => s.symbol).join(' ')}`);
        console.log('');
      }
    } catch (err) {
      console.error(`Could not load the Deriv symbol list: ${err.message}\n`);
    }
  }

  // ---- 2. per-instrument stats ----------------------------------------
  const rows = [];
  for (const instrument of instruments) {
    const connector = instrument.source === 'deriv' ? deriv : oanda;
    const symbolOk = known ? (instrument.source !== 'deriv' ? true : known.has(instrument.symbol)) : null;

    if (symbolOk === false) {
      rows.push({ instrument, error: `symbol "${instrument.symbol}" is not on the feed` });
      continue;
    }

    try {
      const candles = await connector.fetchCandles(instrument.symbol, config.timeframes.ltfSeconds, 500);
      if (candles.length < 20) throw new Error(`only ${candles.length} candles returned`);

      const ranges = candles.map(range).sort((a, b) => a - b);
      const price = candles[candles.length - 1].close;
      const median = percentile(ranges, 50);

      rows.push({
        instrument,
        price,
        median,
        p75: percentile(ranges, 75),
        p90: percentile(ranges, 90),
        // Half a typical 30m candle clears routine noise beyond the sweep wick
        // without widening the stop enough to break the 1:2 gate.
        suggested: median * 0.5,
        configured: resolveStopBuffer(instrument.slBuffer, price),
        candles: candles.length,
      });
    } catch (err) {
      rows.push({ instrument, error: err.message });
    }
  }

  // ---- 3. report -------------------------------------------------------
  console.log('30m candle ranges and stop buffer suggestions\n');
  console.log(
    ['instrument', 'price', 'median', 'p90', 'suggested', 'configured', 'as pct'].map((h, i) => h.padEnd(i ? 14 : 12)).join('')
  );
  console.log('-'.repeat(96));

  for (const row of rows) {
    const { instrument } = row;
    if (row.error) {
      console.log(`${instrument.id.padEnd(12)}${`!! ${row.error}`}`);
      continue;
    }
    const f = (n) => formatPrice(n, instrument).padEnd(14);
    const pct = `${((row.suggested / row.price) * 100).toFixed(4)}%`;
    console.log(
      instrument.id.padEnd(12) +
        f(row.price) +
        f(row.median) +
        f(row.p90) +
        f(row.suggested) +
        f(row.configured) +
        pct
    );
  }

  const uncalibrated = rows.filter((r) => !r.error && r.instrument.calibrated === false);
  if (uncalibrated.length) {
    console.log('\nNot yet calibrated — set these in src/config/instruments.js:');
    for (const row of uncalibrated) {
      const pct = (row.suggested / row.price).toFixed(6);
      console.log(
        `  ${row.instrument.id.padEnd(10)} slBuffer: ${formatPrice(row.suggested, row.instrument)}  ` +
          `(or { pct: ${pct} })  — currently ${formatPrice(row.configured, row.instrument)}`
      );
    }
    console.log('\nAlso confirm minLot / lotStep / contractSize against your own broker contract specs.');
  }

  console.log('');
  deriv.close();
  oanda.close();
}

main().catch((err) => {
  console.error('calibration failed:', err.message);
  process.exit(1);
});
