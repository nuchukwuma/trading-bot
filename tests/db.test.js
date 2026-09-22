'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const Alert = require('../src/db/models/Alert');
const { buildTradePlan } = require('../src/tradeplan');
const { byId } = require('../src/config/instruments');

const VOL75 = byId('VOL75');

function sampleAlert() {
  const plan = buildTradePlan({
    instrument: VOL75,
    direction: 'bullish',
    entryPrice: 100000,
    poi: { direction: 'bullish', top: 100100, bottom: 99900 },
    sweep: { extreme: 99800 },
  });
  return {
    instrument: VOL75,
    direction: 'bullish',
    bias: { direction: 'bullish', strength: 'strong', score: 2, reasons: ['4H bias is bullish'] },
    score: 4,
    required: 3,
    total: 6,
    allConfirmations: [
      { id: 'ltf_structure', name: 'a', passed: true, reason: 'r1' },
      { id: 'premium_discount', name: 'b', passed: false, reason: 'r2' },
    ],
    plan,
    price: 100000,
    candleTime: 1700000000,
    poiId: '30m:OB:bullish:1700000000:99900:100100',
  };
}

test('db: an alert maps onto the persisted document shape', () => {
  const doc = db.toDocument(sampleAlert(), { delivered: true });

  assert.equal(doc.instrumentId, 'VOL75');
  assert.equal(doc.instrumentName, 'Volatility 75 Index');
  assert.equal(doc.instrumentKind, 'synthetic');
  assert.equal(doc.source, 'deriv');
  assert.equal(doc.side, 'BUY');
  assert.equal(doc.direction, 'bullish');
  assert.equal(doc.delivered, true);
  assert.deepEqual(doc.candleTime, new Date(1700000000 * 1000));

  assert.equal(doc.htfBias.direction, 'bullish');
  assert.equal(doc.htfBias.strength, 'strong');
  assert.deepEqual(doc.htfBias.reasons, ['4H bias is bullish']);

  assert.equal(doc.score, 4);
  assert.equal(doc.required, 3);
  assert.equal(doc.confirmations.length, 2, 'every check is stored, fired or not');
  assert.equal(doc.confirmations[1].passed, false);

  assert.equal(doc.tradePlan.entryPrice, 100000);
  assert.equal(doc.tradePlan.stopPrice, 99650);
  assert.equal(doc.tradePlan.riskDistance, 350);
  assert.equal(doc.tradePlan.riskReward, 2);
  assert.equal(doc.tradePlan.targets.length, 3);
  assert.equal(doc.tradePlan.lots, 0.008);
  assert.equal(doc.tradePlan.accountBalance, 10);
  assert.deepEqual(doc.tradePlan.entryZone, { top: 100100, bottom: 99900 });

  assert.equal(doc.poiId, '30m:OB:bullish:1700000000:99900:100100');
  assert.equal(doc.dedupKey, 'VOL75:bullish:30m:OB:bullish:1700000000:99900:100100');
  assert.deepEqual(doc.outcome, { status: 'pending' }, 'outcome is a placeholder for later review');
});

test('db: the document validates against the Alert schema', () => {
  const doc = new Alert(db.toDocument(sampleAlert()));
  const err = doc.validateSync();
  assert.equal(err, undefined);
  assert.equal(doc.outcome.status, 'pending');
  assert.equal(doc.delivered, false);
});

test('db: the schema rejects an unknown outcome status', () => {
  const doc = new Alert({ ...db.toDocument(sampleAlert()), outcome: { status: 'moon' } });
  const err = doc.validateSync();
  assert.ok(err, 'validation should fail');
  assert.ok(err.errors['outcome.status']);
});

test('db: required fields are enforced', () => {
  const err = new Alert({}).validateSync();
  for (const field of ['instrumentId', 'direction', 'side', 'candleTime', 'score']) {
    assert.ok(err.errors[field], `${field} should be required`);
  }
});

test('db: write helpers no-op safely when there is no connection', async () => {
  assert.equal(db.isConnected(), false);
  assert.equal(await db.logAlert(sampleAlert()), null);
  assert.deepEqual(await db.recentAlerts(), []);
  assert.equal(await db.recordOutcome('000000000000000000000000', { status: 'tp1' }), null);
  assert.deepEqual(await db.performanceSummary(), []);
  await db.disconnect(); // idempotent
});
