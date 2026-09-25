'use strict';

// Runs one instrument's replay off the main thread, so a year-long backtest
// on the server does not stall the live scan or Telegram commands.
const { parentPort, workerData } = require('worker_threads');
const { replayInstrument } = require('./replay');

try {
  parentPort.postMessage({ ok: true, result: replayInstrument(workerData) });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err.message });
}
