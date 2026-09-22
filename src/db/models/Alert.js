'use strict';

const mongoose = require('mongoose');

const ConfirmationSchema = new mongoose.Schema(
  {
    id: String,
    name: String,
    passed: Boolean,
    reason: String,
  },
  { _id: false }
);

const TargetSchema = new mongoose.Schema(
  {
    name: String,
    price: Number,
    rr: Number,
    nominalRr: Number,
    closePct: Number,
    remainingPct: Number,
    cappedBy: mongoose.Schema.Types.Mixed,
    moveStopToBreakeven: Boolean,
    trailToStructure: Boolean,
  },
  { _id: false }
);

/**
 * One fired alert. `outcome` is a placeholder filled in later (manually or by a
 * backtest pass) so win rate can be reviewed without re-deriving the setup.
 */
const AlertSchema = new mongoose.Schema(
  {
    instrumentId: { type: String, required: true, index: true },
    instrumentName: String,
    instrumentKind: String,
    source: String,

    direction: { type: String, enum: ['bullish', 'bearish'], required: true },
    side: { type: String, enum: ['BUY', 'SELL'], required: true },

    candleTime: { type: Date, required: true, index: true },
    price: Number,

    htfBias: {
      direction: String,
      strength: String,
      score: Number,
      reasons: [String],
    },

    score: { type: Number, required: true },
    required: Number,
    total: Number,
    confirmations: [ConfirmationSchema],

    tradePlan: {
      entryPrice: Number,
      entryZone: { top: Number, bottom: Number },
      stopPrice: Number,
      stopAnchor: Number,
      stopBuffer: Number,
      riskDistance: Number,
      riskReward: Number,
      targets: [TargetSchema],
      obstacle: mongoose.Schema.Types.Mixed,
      lots: Number,
      riskUsd: Number,
      accountBalance: Number,
      warnings: [String],
    },

    poiId: { type: String, index: true },
    poiKind: String,
    dedupKey: { type: String, index: true },
    delivered: { type: Boolean, default: false },

    // Chart-pattern and context tokens the learner searches over.
    features: { type: [String], index: true },

    // A shadow record is a setup that cleared every structural gate but was
    // held back by the learned profile. It is never sent, but it IS tracked and
    // learned from — otherwise the bot would only ever see outcomes for trades
    // it already believed in, and learning would freeze the moment it narrows.
    shadow: { type: Boolean, default: false, index: true },
    edgeProfileReason: String,

    // Filled in later for win-rate review. Never written by the scanner.
    outcome: {
      status: {
        type: String,
        // tp1-tp3 = furthest target reached; timeout = still open when the
        // review window ended; expired = a limit entry that never filled.
        enum: ['pending', 'tp1', 'tp2', 'tp3', 'breakeven', 'stopped', 'timeout', 'expired', 'cancelled'],
        default: 'pending',
        index: true,
      },
      rMultiple: Number,
      closedAt: Date,
      notes: String,
      // 'simulator' when the bot resolved it from candles, 'manual' otherwise.
      resolvedBy: String,
      barsHeld: Number,
      mfe: Number,
      mae: Number,
    },
  },
  { timestamps: true }
);

AlertSchema.index({ instrumentId: 1, candleTime: -1 });
AlertSchema.index({ instrumentId: 1, direction: 1, createdAt: -1 });

module.exports = mongoose.models.Alert || mongoose.model('Alert', AlertSchema);
