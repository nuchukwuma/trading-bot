'use strict';

const http = require('http');
const config = require('./config');
const { Scanner } = require('./scanner');
const { LearningService } = require('./learn');
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

  // Replit (and most hosts) only treat the app as running once something is
  // listening on a port. Started first, so the host sees it before the database
  // connection and the first scan. Skipped for `--once`, which must exit.
  const keepAlive = runOnce ? null : startKeepAlive();

  log.info(
    `starting — ${config.instruments.length} instrument(s): ${config.instruments.map((i) => i.id).join(', ')}`
  );
  log.info(
    `bias ${config.timeframes.htf} / entries ${config.timeframes.ltf} · ${config.scoring.minConfirmations}+ of ${config.scoring.totalChecks} confirmations · min R:R 1:${config.tradePlan.minRiskReward}`
  );
  if (config.dryRun) log.warn('DRY_RUN is on — alerts are formatted and logged but not sent');

  const uncalibrated = config.instruments.filter((i) => i.calibrated === false);
  if (uncalibrated.length) {
    log.warn(
      `uncalibrated instrument(s): ${uncalibrated
        .map((i) => i.id)
        .join(', ')} — stop buffer and lot constraints are estimates. Run "npm run calibrate".`
    );
  }

  const scanner = new Scanner();
  if (config.learn.enabled && config.db.enabled) {
    scanner.learning = new LearningService({
      onProfileChange: (result) =>
        log.warn(
          `the alert filter has changed — now ${result.growth.featureRulesUsed} feature rule(s) ` +
            `on ${result.growth.trades} resolved trades`
        ),
    });
    log.info(
      `learning on: outcomes resolved each scan, re-learning every ${config.learn.relearnEvery} new results`
    );
  } else if (config.learn.enabled) {
    log.warn('learning needs MongoDB — outcomes cannot be tracked with DB_ENABLED=0');
  }
  log.info(`edge profile: ${scanner.edgeProfile.describe()}`);
  if (!scanner.edgeProfile.active) {
    log.warn(
      'alerts are NOT filtered by backtested performance — run "npm run backtest" to build a profile, ' +
        'or set EDGE_PROFILE_REQUIRED=1 to stay silent until one exists'
    );
  }

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
    if (keepAlive) keepAlive.close();
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

/**
 * Minimal HTTP responder so hosting platforms can see the process is up.
 * A port clash is logged rather than thrown: the bot's real job is scanning,
 * and an unhandled server error would otherwise take it down.
 */
function startKeepAlive(port = process.env.PORT || 3000) {
  const server = http.createServer((req, res) => res.end('SMC bot alive'));
  server.on('error', (err) => log.error(`keep-alive server failed on port ${port}: ${err.message}`));
  server.listen(port, () => log.info(`keep-alive server listening on port ${server.address().port}`));
  return server;
}

if (require.main === module) {
  main().catch((err) => {
    log.error('fatal:', err);
    process.exit(1);
  });
}

module.exports = { main, startKeepAlive };
