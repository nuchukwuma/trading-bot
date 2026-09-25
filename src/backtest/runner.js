'use strict';

const path = require('path');
const { Worker } = require('worker_threads');
const config = require('../config');
const { replayInstrument } = require('./replay');
const { buildReport } = require('./insights');
const { createLogger } = require('../util/logger');

const log = createLogger('backtest');

const RUN_KEY = 'backtestRun';
const REPORT_KEY = 'backtestReport';

/**
 * The backtest, run by the bot itself on the server.
 *
 *   1. page in `days` of 30m and 4H history for every instrument
 *   2. replay each one in a worker thread (the live scan keeps running)
 *   3. store every simulated trade in MongoDB, replacing the previous run
 *   4. re-learn from backtest + live outcomes together and store the profile
 *   5. send the "what worked" report and keep it for /insights
 *
 * Re-runs itself every `refreshDays`, so the seed keeps up with the market.
 */
class BacktestRunner {
  constructor({ data, db, learning, instruments, notify = async () => {}, onProfile = () => {} }) {
    this.data = data;
    this.db = db;
    this.learning = learning;
    this.instruments = instruments;
    this.notify = notify;
    this.onProfile = onProfile;
    this.running = false;
    this.timer = null;
  }

  async lastRun() {
    return (await this.db.getSetting(RUN_KEY).catch(() => null)) || null;
  }

  async report() {
    const r = await this.db.getSetting(REPORT_KEY).catch(() => null);
    return r ? r.text : null;
  }

  /** Run now if the last run is missing or older than refreshDays; check again daily. */
  schedule({ refreshDays = config.backtest.refreshDays, days = config.backtest.days, delayMs = 120000 } = {}) {
    const check = async () => {
      const last = await this.lastRun();
      const age = last ? (Date.now() - new Date(last.finishedAt).getTime()) / 86400000 : Infinity;
      if (age >= refreshDays) {
        log.info(last ? `last backtest is ${age.toFixed(1)} days old — refreshing` : 'no backtest stored yet — running one');
        await this.run({ days, reason: last ? 'weekly refresh' : 'first run' });
      }
    };
    const first = setTimeout(() => check().catch((err) => log.error(`scheduled backtest failed: ${err.message}`)), delayMs);
    first.unref();
    this.timer = setInterval(() => check().catch((err) => log.error(`scheduled backtest failed: ${err.message}`)), 86400000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async run({ days = config.backtest.days, reason = 'requested' } = {}) {
    if (this.running) return false;
    this.running = true;
    const started = Date.now();
    try {
      await this.notify(
        `🔬 <b>Backtest started</b> (${reason}) — ${this.instruments.length} pairs over the last ${days} days. ` +
          'Alerts keep running; the report follows when it is done.'
      );

      const trades = [];
      const coverage = [];
      for (const instrument of this.instruments) {
        try {
          const { htf, ltf } = await this.data.getHistory(instrument, {
            days,
            htfSeconds: config.timeframes.htfSeconds,
            ltfSeconds: config.timeframes.ltfSeconds,
          });
          if (ltf.length < 500) {
            log.warn(`${instrument.id}: only ${ltf.length} candles — skipped`);
            continue;
          }
          const run = await replayOffThread({ instrument, htf, ltf, opts: { simulator: { maxBars: config.learn.maxBars } } });
          trades.push(...run.trades);
          const spanDays = (ltf[ltf.length - 1].time - ltf[0].time) / 86400;
          coverage.push({ id: instrument.id, days: spanDays, trades: run.trades.length });
          log.info(`${instrument.id}: ${ltf.length} candles (${spanDays.toFixed(0)} days) -> ${run.trades.length} setups`);
        } catch (err) {
          log.error(`${instrument.id}: backtest failed — ${err.message}`);
        }
      }
      trades.sort((a, b) => a.time - b.time);
      if (!trades.length) {
        await this.notify('🔬 Backtest found no setups — nothing stored. Check the data feed.');
        return true;
      }

      const runId = new Date(started).toISOString();
      await this.db.replaceBacktestTrades(trades, runId);

      this.learning.ledgerStale = true;
      const learned = await this.learning.relearn({ force: true });
      if (this.learning.profile) this.onProfile(this.learning.profile);

      const text = buildReport({ trades, result: learned && learned.result, days, coverage });
      const finishedAt = new Date().toISOString();
      await this.db.setSetting(REPORT_KEY, { text, generatedAt: finishedAt, runId });
      await this.db.setSetting(RUN_KEY, { startedAt: runId, finishedAt, days, trades: trades.length, coverage });
      log.info(`backtest done in ${Math.round((Date.now() - started) / 1000)}s — ${trades.length} setups stored`);
      await this.notify(text);
      return true;
    } catch (err) {
      log.error(`backtest failed: ${err.message}`);
      await this.notify(`🔬 Backtest failed: ${err.message}`).catch(() => {});
      return true;
    } finally {
      this.running = false;
    }
  }
}

/** Replay in a worker thread; fall back to the main thread if workers are unavailable. */
function replayOffThread(workerData) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(path.join(__dirname, 'replayWorker.js'), { workerData });
    } catch (err) {
      resolve(replayInstrument(workerData));
      return;
    }
    worker.once('message', (msg) => (msg.ok ? resolve(msg.result) : reject(new Error(msg.error))));
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`replay worker exited with code ${code}`));
    });
  });
}

module.exports = { BacktestRunner, replayOffThread, RUN_KEY, REPORT_KEY };
