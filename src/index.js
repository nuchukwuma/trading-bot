'use strict';

const config = require('./config');
const { Scanner } = require('./scanner');
const { LearningService } = require('./learn');
const db = require('./db');
const { createLogger } = require('./util/logger');
const { msUntilNextBoundary, formatUtc } = require('./util/time');
const { parseHours, startServer, startKeepAwake } = require('./server');
const { AlertSettings } = require('./control/settings');
const { TelegramControl } = require('./control/telegramBot');

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
  const status = { lastScanAt: null, lastScanMs: null, nextScanAt: null, scans: 0 };

  // Hosts (Render, Replit) only treat the app as running once something is
  // listening on a port, and Render fails a deploy whose port does not open
  // soon after start. Started first, before the database and the first scan.
  // Skipped for `--once`, which must exit.
  let server = null;
  let keepAwake = null;
  if (!runOnce) {
    server = startServer({
      port: config.server.port,
      getStatus: () => ({ instruments: config.instruments.map((i) => i.id), ...status }),
    });
    const ka = config.server.keepAwake;
    if (ka.enabled && ka.url) {
      keepAwake = startKeepAwake({
        url: ka.url,
        intervalMs: ka.intervalMinutes * 60 * 1000,
        window: parseHours(ka.hours),
        tz: ka.tz,
      });
    } else if (ka.enabled) {
      log.warn('keep-awake has no URL — set KEEP_AWAKE_URL (Render provides RENDER_EXTERNAL_URL itself)');
    }
  }

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

  // Which pairs alert, chosen from Telegram; kept in MongoDB when available.
  scanner.settings = await new AlertSettings({
    instruments: config.instruments,
    db: scanner.persist ? db : null,
  }).load();
  if (scanner.settings.muted.size) log.info(`alerts off for: ${[...scanner.settings.muted].join(', ')}`);
  if (scanner.settings.paused) log.warn('alerts are paused from Telegram — /resume to start again');

  let stopping = false;
  let timer = null;
  let control = null;

  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal} received — shutting down`);
    if (timer) clearTimeout(timer);
    if (keepAwake) keepAwake.stop();
    if (control) control.stop();
    if (server) server.close();
    scanner.close();
    await db.disconnect().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Scheduled scans and /scan from Telegram share this; a second call while
  // one is running returns null instead of overlapping.
  let scanning = false;
  const runScan = async () => {
    if (scanning) return null;
    scanning = true;
    const started = Date.now();
    let results = [];
    try {
      results = await scanner.scanAll(started);
    } catch (err) {
      log.error(`scan pass failed: ${err.message}`);
    } finally {
      scanning = false;
    }
    status.scans += 1;
    status.lastScanAt = new Date(started).toISOString();
    status.lastScanMs = Date.now() - started;
    log.debug(`scan took ${status.lastScanMs}ms`);
    return results;
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
    status.nextScanAt = new Date(at * 1000).toISOString();
    log.info(`next scan at ${formatUtc(at)} (in ${Math.round(wait / 1000)}s)`);
    timer = setTimeout(async () => {
      await runScan();
      scheduleNext();
    }, wait);
  };

  const tg = config.alerts.telegram;
  if (tg.commands && scanner.alerts.telegram.configured) {
    control = await new TelegramControl({
      telegram: scanner.alerts.telegram,
      settings: scanner.settings,
      chatId: tg.chatId,
      runScan,
      getStatus: () => ({ ...status, database: scanner.persist }),
    }).start();
  }

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
