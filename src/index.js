'use strict';

const config = require('./config');
const { Scanner } = require('./scanner');
const db = require('./db');
const { createLogger } = require('./util/logger');
const { msUntilNextBoundary, formatUtc } = require('./util/time');

const log = createLogger('bot');

/**
 * Entry point.
 *
 * Runs a scan on every 30m candle close, round the clock — there is no session
 * filter, by design. `--once` runs a single pass and exits, which is what the
 * `npm run scan` script uses.
 */
async function main() {
  const runOnce = process.argv.includes('--once');

  log.info(
    `starting — ${config.instruments.length} instrument(s): ${config.instruments.map((i) => i.id).join(', ')}`
  );
  log.info(
    `bias ${config.timeframes.htf} / entries ${config.timeframes.ltf} · ${config.scoring.minConfirmations}+ of ${config.scoring.totalChecks} confirmations · min R:R 1:${config.tradePlan.minRiskReward}`
  );
  if (config.dryRun) log.warn('DRY_RUN is on — alerts are formatted and logged but not sent');

  const scanner = new Scanner();

  if (config.db.enabled) {
    try {
      await db.connect();
      const recent = await db.recentAlerts();
      scanner.alerts.seedFrom(recent);
      log.info(`seeded de-duplication with ${recent.length} recent alert(s)`);
    } catch (err) {
      log.error(`MongoDB unavailable (${err.message}) — continuing without persistence`);
      scanner.persist = false;
    }
  }

  let stopping = false;
  let timer = null;

  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal} received — shutting down`);
    if (timer) clearTimeout(timer);
    scanner.close();
    await db.disconnect().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  const runScan = async () => {
    const started = Date.now();
    try {
      await scanner.scanAll(started);
    } catch (err) {
      log.error(`scan pass failed: ${err.message}`);
    }
    log.debug(`scan took ${Date.now() - started}ms`);
  };

  if (runOnce) {
    await runScan();
    scanner.close();
    await db.disconnect().catch(() => {});
    return;
  }

  const scheduleNext = () => {
    if (stopping) return;
    const wait = msUntilNextBoundary(config.scheduler.intervalSeconds, config.scheduler.closeDelaySeconds);
    const at = Math.floor((Date.now() + wait) / 1000);
    log.info(`next scan at ${formatUtc(at)} (in ${Math.round(wait / 1000)}s)`);
    timer = setTimeout(async () => {
      await runScan();
      scheduleNext();
    }, wait);
  };

  if (config.scheduler.scanOnStart) await runScan();
  scheduleNext();
}

if (require.main === module) {
  main().catch((err) => {
    log.error('fatal:', err);
    process.exit(1);
  });
}

module.exports = { main };
