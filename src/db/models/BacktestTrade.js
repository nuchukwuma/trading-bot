'use strict';

const mongoose = require('mongoose');

/**
 * One trade from a backtest replay — the seed half of the learner's ledger.
 * Stored in MongoDB rather than a file so it survives restarts on hosts with
 * a wiped disk (Render). The record shape is whatever replay.js produces; only
 * the fields queried on are declared.
 */
const BacktestTradeSchema = new mongoose.Schema(
  {
    runId: { type: String, index: true },
    instrumentId: { type: String, index: true },
    time: { type: Number, index: true },
  },
  { strict: false, timestamps: false, minimize: false }
);

module.exports = mongoose.models.BacktestTrade || mongoose.model('BacktestTrade', BacktestTradeSchema);
