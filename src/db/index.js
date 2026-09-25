'use strict';

const mongoose = require('mongoose');
const config = require('../config');
const Alert = require('./models/Alert');
const Setting = require('./models/Setting');
const { createLogger } = require('../util/logger');

const log = createLogger('db');

let connected = false;

async function connect(uri = config.db.uri, opts = {}) {
  if (connected) return mongoose.connection;
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000, ...opts });
  connected = true;
  log.info('connected to MongoDB');
  return mongoose.connection;
}

async function disconnect() {
  if (!connected) return;
  await mongoose.disconnect();
  connected = false;
}

const isConnected = () => connected && mongoose.connection.readyState === 1;

/** Map a fired alert onto the persisted document shape. */
function toDocument(alert, { delivered = false, shadow = false } = {}) {
  const { instrument, plan, bias } = alert;
  return {
    instrumentId: instrument.id,
    instrumentName: instrument.displayName,
    instrumentKind: instrument.kind,
    source: instrument.source,

    direction: alert.direction,
    side: plan.side,

    candleTime: new Date(alert.candleTime * 1000),
    price: alert.price,

    htfBias: {
      direction: bias.direction,
      strength: bias.strength,
      score: bias.score,
      reasons: bias.reasons || [],
    },

    score: alert.score,
    required: alert.required,
    total: alert.total,
    confirmations: (alert.allConfirmations || alert.confirmations || []).map((c) => ({
      id: c.id,
      name: c.name,
      passed: c.passed,
      reason: c.reason,
    })),

    tradePlan: {
      entryPrice: plan.entryPrice,
      entryZone: plan.entryZone || undefined,
      stopPrice: plan.stopPrice,
      stopAnchor: plan.stopAnchor,
      stopBuffer: plan.stopBuffer,
      riskDistance: plan.riskDistance,
      riskReward: plan.riskReward,
      targets: plan.targets,
      obstacle: plan.obstacle || undefined,
      lots: plan.position.lots,
      riskUsd: plan.position.actualRiskUsd,
      accountBalance: config.risk.accountBalance,
      warnings: plan.warnings || [],
    },

    poiId: alert.poiId,
    poiKind: alert.poiKind || null,
    dedupKey: `${instrument.id}:${alert.direction}:${alert.poiId || 'no-poi'}`,
    delivered,
    features: alert.features || [],
    shadow: Boolean(shadow),
    edgeProfileReason: alert.edgeProfile ? alert.edgeProfile.reason : undefined,
    rating: alert.rating || undefined,
    telegramMessageId: alert.telegramMessageId || undefined,
    outcome: { status: 'pending' },
  };
}

async function pendingAlerts(instrumentId, { limit = 200 } = {}) {
  if (!isConnected()) return [];
  return Alert.find({ instrumentId, 'outcome.status': 'pending' })
    .sort({ candleTime: 1 })
    .limit(limit)
    .lean();
}

/** Every alert whose outcome is known — the learner's live training set. */
async function resolvedAlerts({ limit = 20000 } = {}) {
  if (!isConnected()) return [];
  return Alert.find({ 'outcome.status': { $ne: 'pending' } })
    .sort({ candleTime: 1 })
    .limit(limit)
    .lean();
}

async function logAlert(alert, opts = {}) {
  if (!isConnected()) {
    log.debug('not connected — alert not persisted');
    return null;
  }
  const doc = await Alert.create(toDocument(alert, opts));
  log.debug(`logged alert ${doc._id}`);
  return doc;
}

/** Recent alerts, newest first — used to re-seed the dedup window on startup. */
async function recentAlerts({ sinceMinutes = config.alerts.dedup.ttlMinutes, limit = 200 } = {}) {
  if (!isConnected()) return [];
  const since = new Date(Date.now() - sinceMinutes * 60 * 1000);
  return Alert.find({ createdAt: { $gte: since } })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
}

async function updateProgress(alertId, progress) {
  if (!isConnected()) return null;
  return Alert.updateOne({ _id: alertId }, { $set: { progress } });
}

/** Alerts that were sent and have not played out yet, oldest first. */
async function openAlerts({ limit = 50 } = {}) {
  if (!isConnected()) return [];
  return Alert.find({ 'outcome.status': 'pending', delivered: true, shadow: { $ne: true } })
    .sort({ candleTime: 1 })
    .limit(limit)
    .lean();
}

/** Sent alerts that have played out, newest first. */
async function closedAlerts({ limit = 10, since = null } = {}) {
  if (!isConnected()) return [];
  const q = { 'outcome.status': { $ne: 'pending' }, delivered: true, shadow: { $ne: true } };
  if (since) q['outcome.closedAt'] = { $gte: since };
  return Alert.find(q).sort({ 'outcome.closedAt': -1 }).limit(limit).lean();
}

/** Setups on pairs that are muted or held back, still being tracked. */
async function countTrackedShadows() {
  if (!isConnected()) return 0;
  return Alert.countDocuments({ 'outcome.status': 'pending', shadow: true });
}

async function recordOutcome(alertId, outcome) {
  if (!isConnected()) return null;
  return Alert.findByIdAndUpdate(
    alertId,
    { $set: { outcome: { ...outcome, closedAt: outcome.closedAt || new Date() } } },
    { new: true }
  );
}

/** Win-rate style rollup for later review. */
async function performanceSummary({ instrumentId = null } = {}) {
  if (!isConnected()) return [];
  const match = instrumentId ? { instrumentId } : {};
  return Alert.aggregate([
    { $match: match },
    {
      $group: {
        _id: { instrumentId: '$instrumentId', status: '$outcome.status' },
        count: { $sum: 1 },
        avgR: { $avg: '$outcome.rMultiple' },
        avgScore: { $avg: '$score' },
      },
    },
    { $sort: { '_id.instrumentId': 1 } },
  ]);
}

async function getSetting(key) {
  const doc = await Setting.findOne({ key }).lean();
  return doc ? doc.value : undefined;
}

async function setSetting(key, value) {
  await Setting.updateOne({ key }, { $set: { value } }, { upsert: true });
}

module.exports = {
  updateProgress,
  openAlerts,
  closedAlerts,
  countTrackedShadows,
  getSetting,
  setSetting,
  connect,
  disconnect,
  isConnected,
  logAlert,
  toDocument,
  recentAlerts,
  pendingAlerts,
  resolvedAlerts,
  recordOutcome,
  performanceSummary,
  Alert,
  mongoose,
};
