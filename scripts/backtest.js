#!/usr/bin/env node
'use strict';

/**
 * Backtest the strategy and derive the alert filter.
 *
 *   npm run backtest                  every enabled instrument
 *   npm run backtest -- VOL75 JUMP75  just these
 *   npm run backtest -- --synthetic   random-walk harness check (no real data)
 *   npm run backtest -- --no-write    report only, leave the profile alone
 *
 * Writes data/edge-profile.json, which the scanner then enforces before
 * sending any alert.
 */

const config = require('../src/config');
const { MarketDataService } = require('../src/data');
const { replayAll } = require('../src/backtest/replay');
const { analyzeDimensions } = require('../src/backtest/analyze');
const { EdgeProfile } = require('../src/backtest/edgeProfile');
const { saveBacktestTrades } = require('../src/learn/ledger');
const { learn } = require('../src/learn/learner');
const { randomWalkSeries } = require('../src/backtest/randomWalk');
const { formatUtc } = require('../src/util/time');

const R = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(3)}`;
const PCT = (n) => `${(n * 100).toFixed(1)}%`;

function row(label, s, width = 26) {
  if (!s.n) return `${label.padEnd(width)}${'—'.padStart(6)}`;
  return (
    label.padEnd(width) +
    String(s.n).padStart(6) +
    PCT(s.winRate).padStart(9) +
    PCT(s.winRateLower).padStart(10) +
    R(s.expectancy).padStart(11) +
    R(s.expectancyLower).padStart(11) +
    R(s.totalR).padStart(11) +
    R(s.maxDrawdownR).padStart(10)
  );
}

const HEADER =
  'bucket'.padEnd(26) +
  'n'.padStart(6) +
  'win%'.padStart(9) +
  'win95%'.padStart(10) +
  'expR'.padStart(11) +
  'expR95%'.padStart(11) +
  'totalR'.padStart(11) +
  'maxDD'.padStart(10);

function section(title, buckets) {
  if (!buckets.length) return;
  console.log(`\n${title}`);
  console.log(HEADER);
  console.log('-'.repeat(94));
  for (const b of buckets) console.log(row(b.key, b));
}

async function loadSeries(instruments, { synthetic, bars, drift = 0 }) {
  if (synthetic) {
    console.log('\n*** SYNTHETIC MODE — random-walk candles, not market data. ***');
    console.log('*** These numbers measure the harness, not the strategy.   ***\n');
    return instruments.map((instrument, i) => {
      const { ltf, htf } = randomWalkSeries({ bars, seed: 1000 + i, drift });
      // The walk runs at its own price scale, so an absolute stop buffer from
      // the registry would be meaningless against it. A pct buffer keeps the
      // stop a sane multiple of candle range whatever the level.
      return { instrument: { ...instrument, slBuffer: { pct: 0.002 } }, htf, ltf };
    });
  }

  const data = new MarketDataService();
  const out = [];
  for (const instrument of instruments) {
    try {
      const { htf, ltf } = await data.getBiasAndEntryCandles(instrument, {
        htfSeconds: config.timeframes.htfSeconds,
        ltfSeconds: config.timeframes.ltfSeconds,
        htfCount: Math.ceil(bars / 8) + 100,
        ltfCount: bars,
      });
      console.log(`${instrument.id.padEnd(10)} ${ltf.length} x 30m, ${htf.length} x 4H`);
      out.push({ instrument, htf, ltf });
    } catch (err) {
      console.error(`${instrument.id.padEnd(10)} skipped: ${err.message}`);
    }
  }
  data.close();
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const synthetic = args.includes('--synthetic');
  const noWrite = args.includes('--no-write') || synthetic;
  const barsArg = args.find((a) => a.startsWith('--bars='));
  const bars = barsArg ? Number(barsArg.split('=')[1]) : config.backtest.candles;
  // Synthetic only: inject a known drift so the selector can be checked for
  // false negatives as well as false positives.
  const driftArg = args.find((a) => a.startsWith('--drift='));
  const drift = driftArg ? Number(driftArg.split('=')[1]) : 0;
  const ids = args.filter((a) => !a.startsWith('--')).map((a) => a.toUpperCase());

  const instruments = config.allInstruments.filter((i) => i.enabled && (ids.length === 0 || ids.includes(i.id)));
  if (!instruments.length) {
    console.error('No matching instruments.');
    process.exit(1);
  }

  console.log('Loading candles...');
  const series = await loadSeries(instruments, { synthetic, bars, drift });
  if (!series.length) {
    console.error('\nNo candle data available — cannot backtest.');
    process.exit(1);
  }

  const { runs, trades } = replayAll({
    series,
    opts: {
      warmupBars: config.backtest.warmupBars,
      tailBars: config.backtest.tailBars,
      simulator: { maxBars: config.backtest.maxBars, pessimistic: config.backtest.pessimistic },
    },
  });

  console.log('\nReplay');
  console.log('-'.repeat(94));
  for (const r of runs) {
    const s = r.skipped;
    console.log(
      `${r.instrumentId.padEnd(10)} ${String(r.trades.length).padStart(5)} trades from ${String(
        r.evaluatedBars
      ).padStart(5)} bars   ` + `(no bias ${s.bias}, low score ${s.confirmations}, gated ${s.gate}, duplicate ${s.dedup})`
    );
  }

  if (trades.length === 0) {
    console.log('\nNo trades were generated — nothing to analyse.');
    return;
  }

  console.log(`\nWindow: ${formatUtc(trades[0].time)} to ${formatUtc(trades[trades.length - 1].time)}`);

  const dims = analyzeDimensions(trades);
  console.log('\nOverall (every setup that cleared the existing gates)');
  console.log(HEADER);
  console.log('-'.repeat(94));
  console.log(row('all trades', dims.overall));

  section('By confirmation score', dims.byScore);
  section('By instrument', dims.byInstrument);
  section('By bias strength', dims.byBiasStrength);
  section('By direction', dims.byDirection);
  section('By entry POI kind', dims.byPoiKind);
  section('By outcome', dims.byStatus);

  console.log('\nBy individual confirmation (trades where it fired)');
  console.log(HEADER);
  console.log('-'.repeat(94));
  for (const c of dims.byConfirmation) console.log(row(c.key, c.with));

  // ---- the selected profile ----
  // The learner is the same one the live bot re-runs as outcomes accumulate;
  // the backtest simply gives it its first sample.
  const selection = learn(trades, {
    minSamples: config.backtest.minSamples,
    trainRatio: config.backtest.trainRatio,
    tradesPerRule: config.learn.tradesPerRule,
    maxFeatureRules: config.learn.maxFeatureRules,
    fdr: config.learn.fdr,
  });

  console.log('\n\nSelected profile');
  console.log('='.repeat(94));
  for (const note of selection.notes) console.log(`  - ${note}`);

  console.log('\n  Rules:');
  console.log(`    minScore               ${selection.rules.minScore ?? '(none)'}`);
  console.log(`    requiredFeatures       ${selection.rules.requiredFeatures.join(', ') || '(none)'}`);
  console.log(`    excludedFeatures       ${selection.rules.excludedFeatures.join(', ') || '(none)'}`);
  console.log(`    minBiasStrength        ${selection.rules.minBiasStrength || '(none)'}`);
  console.log(`    disabledInstruments    ${selection.rules.disabledInstruments.join(', ') || '(none)'}`);
  console.log(
    `\n  Growth: ${selection.growth.trades} trades earns ${selection.growth.featureRuleBudget} feature rule(s), ` +
      `${selection.growth.featureRulesUsed} used. Next rule unlocks at ${selection.growth.nextRuleAt} trades.`
  );

  const top = selection.candidates.filter((c) => c.significant).slice(0, 8);
  if (top.length) {
    console.log('\n  Features that survived false-discovery control:');
    for (const c of top) {
      console.log(
        `    ${c.feature.padEnd(34)} n=${String(c.with.n).padStart(5)}  ` +
          `${R(c.with.expectancy)}R vs ${R(c.without.expectancy)}R  p=${c.p.toExponential(1)}`
      );
    }
  } else {
    console.log('\n  No feature survived false-discovery control.');
  }

  console.log('\n  Performance');
  console.log(HEADER);
  console.log('-'.repeat(94));
  console.log(row('unfiltered (all)', selection.unfilteredAll));
  console.log(row('filtered (all)', selection.filteredAll));
  console.log(row('filtered (train)', selection.train));
  console.log(row('unfiltered (holdout)', selection.unfilteredTest));
  console.log(row('filtered (holdout)', selection.test));

  console.log(
    `\n  Out-of-sample validation: ${selection.validated ? 'PASSED' : 'FAILED — profile will not be enforced'}`
  );

  if (!noWrite) {
    saveBacktestTrades(config.learn.seedPath, trades, {
      instruments: series.map((s) => s.instrument.id),
      bars,
      generatedAt: new Date().toISOString(),
    });
    console.log(`\n  Seed ledger: ${trades.length} trades -> ${config.learn.seedPath}`);

    const written = EdgeProfile.save(config.edge.profilePath, {
      ...selection,
      meta: {
        instruments: series.map((s) => s.instrument.id),
        bars,
        trades: trades.length,
        from: trades[0].time,
        to: trades[trades.length - 1].time,
        pessimistic: config.backtest.pessimistic,
      },
    });
    console.log(`\n  Written to ${config.edge.profilePath} (validated: ${written.validated})`);
    if (!written.validated) {
      console.log('  The scanner will NOT enforce it. Collect more history and re-run.');
    }
  } else {
    console.log('\n  Not written (--no-write or --synthetic).');
  }
  console.log('');
}

main().catch((err) => {
  console.error('backtest failed:', err.message);
  process.exit(1);
});
