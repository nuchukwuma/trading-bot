'use strict';

const mongoose = require('mongoose');

/** One movement on the demo account: a deposit, a withdrawal, or a trade result. */
const PaperTxnSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['deposit', 'withdraw', 'open', 'result', 'skip', 'risk'], required: true },
    amount: Number,
    balanceAfter: Number,
    alertId: String,
    instrumentId: String,
    note: String,
  },
  { timestamps: true }
);

module.exports = mongoose.models.PaperTxn || mongoose.model('PaperTxn', PaperTxnSchema);
