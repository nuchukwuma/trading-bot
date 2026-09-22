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
    dedupKey: { type: String, index: true },
    delivered: { type: Boolean, default: false },

    // Filled in later for win-rate review. Never written by the scanner.
    outcome: {
      status: {
        type: String,
        enum: ['pending', 'tp1', 'tp2', 'tp3', 'breakeven', 'stopped', 'cancelled'],
        default: 'pending',
        index: true,
      },
      rMultiple: Number,
      closedAt: Date,
      notes: String,
    },
  },
  { timestamps: true }
);

AlertSchema.index({ instrumentId: 1, candleTime: -1 });
AlertSchema.index({ instrumentId: 1, direction: 1, createdAt: -1 });

module.exports = mongoose.models.Alert || mongoose.model('Alert', AlertSchema);
