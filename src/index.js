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
const { formatTradeEvent, formatOpenTrades, formatResults } = require('./alerts/tradeUpdates');
const { rateSetup } = require('./learn/rater');
const { loadBacktestTrades } = require('./learn/ledger');
const { describeAdjust } = require('./learn/planVariants');

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
      kindOf: (id) => (config.instrumentById(id) || {}).kind || null,
      // Follow every SENT alert to its end and tell the user, replying to the
      // original message. Shadow setups are tracked silently.
      onTradeEvent: async (doc, event) => {
        if (!doc.delivered || doc.shadow || config.dryRun) return;
        if (!scanner.alerts.telegram.configured) return;
        await scanner.alerts.telegram.sendMessage(formatTradeEvent(doc, event), { replyTo: doc.telegramMessageId });
      },
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

  // Rate each alert against how similar setups have done. With the learner,
  // that is backtest + live outcomes; without a database, the backtest only.
  if (scanner.learning && scanner.persist) {
    const trades = await scanner.learning.loadLedger().catch((err) => {
      log.warn(`could not load the trade ledger: ${err.message}`);
      return [];
    });
    scanner.rater = scanner.learning;
    log.info(`ratings use ${trades.length} resolved trade(s)`);
  } else {
    const seed = loadBacktestTrades(config.learn.seedPath);
    const kindOf = (id) => (config.instrumentById(id) || {}).kind || null;
    scanner.rater = { rate: (setup) => rateSetup(seed, setup, { minSamples: config.learn.minSamples, kindOf }) };
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
      reports: scanner.persist
        ? {
            trades: async () =>
              formatOpenTrades(await db.openAlerts(), {
                shadowCount: await db.countTrackedShadows(),
                nextScanAt: status.nextScanAt,
              }),
            results: async (days) =>
              formatResults(await db.closedAlerts({ limit: 200, since: new Date(Date.now() - days * 86400000) }), {
                days,
              }),
            learning: async () => describeLearning(scanner),
          }
        : {},
    }).start();
  }

  if (config.scheduler.scanOnStart) await runScan();
  scheduleNext();
}

/** /learning — how much the bot has seen and what it filters on. */
function describeLearning(scanner) {
  const trades = (scanner.learning && scanner.learning.trades) || [];
  const filled = trades.filter((t) => t.filled);
  const live = filled.filter((t) => t.source && t.source !== 'backtest').length;
  const profile = scanner.edgeProfile;
  const growth = profile.loaded && profile.data.meta && profile.data.meta.growth;
  const lines = [
    '<b>Learning</b>',
    `Resolved trades: ${filled.length} (${live} live, ${filled.length - live} backtest)`,
  ];
  if (!profile.loaded) {
    lines.push('Filter: none yet — every setup that passes the rules is sent.');
  } else {
    lines.push(`Filter: ${profile.describe()}`);
    lines.push(
      profile.active
        ? '✅ Validated on trades it was not fitted to — only setups that match it are sent.'
        : '⚠️ Not validated yet, so it is not applied — every setup that passes the rules is sent.'
    );
  }
  if (growth) {
    lines.push(
      `Pattern rules: ${growth.featureRulesUsed} of ${growth.featureRuleBudget} allowed at this sample size; ` +
        `one more is allowed at ${growth.nextRuleAt} trades.`
    );
  }
  const plan = profile.loaded && profile.data.plan;
  lines.push('', '<b>Stop and target placement</b>');
  if (!plan) {
    lines.push('Default placement — nothing learned yet.');
  } else {
    const adopted = Object.values(plan.byGroup || {});
    if (!adopted.length) lines.push('Default placement everywhere — no alternative has proven better yet.');
    for (const a of adopted) {
      lines.push(
        `📐 ${a.label}: ${describeAdjust(a)} (${a.adjustedR.toFixed(2)}R vs ${a.baselineR.toFixed(2)}R on ${a.testTrades} later trades)`
      );
    }
    for (const n of (plan.notes || []).filter((x) => !/ADOPTED/.test(x))) lines.push(`• ${n}`);
  }
  lines.push('');

  const minSamples = config.learn.minSamples;
  if (filled.length < minSamples) {
    lines.push(`It starts judging once ${minSamples} trades have resolved.`);
  } else {
    lines.push(`It re-learns after every ${config.learn.relearnEvery} new results.`);
  }
  lines.push('', '<i>Each alert carries a rating from these results: 🟢 high probability, 🟡 no clear edge yet, 🔴 low, ⚪️ not enough history.</i>');
  return lines.join('\n');
}

if (require.main === module) {
  main().catch((err) => {
    log.error('fatal:', err);
    process.exit(1);
  });
}

module.exports = { main };
