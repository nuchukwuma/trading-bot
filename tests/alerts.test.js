'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { formatAlert, formatAlertLine, escapeHtml } = require('../src/alerts/format');
const { AlertDeduplicator } = require('../src/alerts/dedup');
const { TelegramClient, splitMessage } = require('../src/alerts/telegram');
const { AlertService } = require('../src/alerts');
const { buildTradePlan } = require('../src/tradeplan');
const { byId } = require('../src/config/instruments');

const VOL75 = byId('VOL75');

function sampleAlert(overrides = {}) {
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
    bias: { direction: 'bullish', strength: 'strong', score: 2, reasons: ['4H bias is bullish — break of structure'] },
    score: 4,
    required: 3,
    total: 6,
    confirmations: [
      { id: 'ltf_structure', passed: true, reason: '30m BOS aligned with HTF bias' },
      { id: 'liquidity_sweep', passed: true, reason: 'Liquidity sweep before shift — stop hunt taken before reversal' },
      { id: 'poi_retrace', passed: true, reason: 'Retrace into an unmitigated 30m order block' },
      { id: 'displacement', passed: true, reason: 'Displacement candle drove the move' },
    ],
    allConfirmations: [
      { id: 'ltf_structure', passed: true, reason: '30m BOS aligned with HTF bias' },
      { id: 'liquidity_sweep', passed: true, reason: 'Liquidity sweep before shift — stop hunt taken before reversal' },
      { id: 'poi_retrace', passed: true, reason: 'Retrace into an unmitigated 30m order block' },
      { id: 'premium_discount', passed: false, reason: 'Entry sits in premium — longs want discount' },
      { id: 'htf_confluence', passed: false, reason: 'No overlap with a 4H POI' },
      { id: 'displacement', passed: true, reason: 'Displacement candle drove the move' },
    ],
    plan,
    price: 100000,
    candleTime: 1700000000,
    poiId: '30m:OB:bullish:1700000000:99900:100100',
    ...overrides,
  };
}

// ---------------------------------------------------------------- formatting
test('format: the alert carries direction, plan, size and every fired reason', () => {
  const msg = formatAlert(sampleAlert());

  assert.match(msg, /🟢 <b>BUY VOL75<\/b> — Volatility 75 Index/);
  assert.match(msg, /4\/6 confirmations · 4H bias BULLISH \(strong\)/);
  assert.match(msg, /Entry  100000\.0000/);
  assert.match(msg, /Stop   99650\.0000  \(350 pts\)/);
  assert.match(msg, /TP1    100700\.0000  1:2\.00  close 50%/);
  assert.match(msg, /TP2    101225\.0000  1:3\.50  close 30%/);
  assert.match(msg, /TP3    101750\.0000  1:5\.00  close 20%/);
  assert.match(msg, /SL to breakeven/);
  assert.match(msg, /trail behind structure/);
  assert.match(msg, /0\.008 lots · risk \$2\.80 of \$10\.00/);
  assert.match(msg, /R:R to TP1 1:2\.00/);

  for (const reason of sampleAlert().confirmations.map((c) => c.reason)) {
    assert.ok(msg.includes(reason), `missing reason: ${reason}`);
  }
  assert.match(msg, /Analysis only — this bot places no orders\./);
  assert.match(msg, /30m candle close 2023-11-14 22:13 UTC/);
});

test('format: checks that did not fire are listed separately', () => {
  const msg = formatAlert(sampleAlert());
  assert.match(msg, /<b>Did not fire<\/b>/);
  assert.match(msg, /▫️ Entry sits in premium — longs want discount/);
  assert.match(msg, /▫️ No overlap with a 4H POI/);
});

test('format: shorts render with the sell styling', () => {
  const plan = buildTradePlan({
    instrument: VOL75,
    direction: 'bearish',
    entryPrice: 100000,
    poi: { direction: 'bearish', top: 100100, bottom: 99900 },
    sweep: { extreme: 100200 },
  });
  const msg = formatAlert(sampleAlert({ direction: 'bearish', plan, bias: { direction: 'bearish', strength: 'moderate', score: 1, reasons: [] } }));
  assert.match(msg, /🔴 <b>SELL VOL75<\/b>/);
  assert.match(msg, /4H bias BEARISH \(moderate\)/);
});

test('format: sizing warnings surface in the message', () => {
  const plan = buildTradePlan({
    instrument: byId('EURUSD'),
    direction: 'bullish',
    entryPrice: 1.1,
    poi: { direction: 'bullish', top: 1.1005, bottom: 1.0946 },
    sweep: { extreme: 1.0946 },
  });
  const msg = formatAlert(sampleAlert({ instrument: byId('EURUSD'), plan }));
  assert.match(msg, /⚠️ Warnings/);
  assert.match(msg, /too wide for a \$3 risk/);
});

test('format: a capped target is called out', () => {
  const plan = buildTradePlan({
    instrument: VOL75,
    direction: 'bullish',
    entryPrice: 100000,
    poi: { direction: 'bullish', top: 100100, bottom: 99900 },
    sweep: { extreme: 99800 },
    obstacle: { price: 101000, kind: 'EQH', count: 2, source: 'liquidity' },
  });
  const msg = formatAlert(sampleAlert({ plan }));
  assert.match(msg, /TP2\/TP3 pulled back to EQH liquidity at 101000\.0000/);
});

test('format: HTML metacharacters in reasons are escaped', () => {
  const alert = sampleAlert();
  alert.confirmations = [{ id: 'x', passed: true, reason: 'break of <structure> & liquidity' }];
  alert.allConfirmations = alert.confirmations;
  const msg = formatAlert(alert);
  assert.match(msg, /break of &lt;structure&gt; &amp; liquidity/);
  assert.equal(escapeHtml('<a href="x">&</a>'), '&lt;a href="x"&gt;&amp;&lt;/a&gt;');
});

test('format: the one-line log form is compact', () => {
  assert.match(
    formatAlertLine(sampleAlert()),
    /^BUY VOL75 @ 100000\.0000 SL 99650\.0000 TP1 100700\.0000 \| 4\/6 \| 0\.008 lots$/
  );
});

// ---------------------------------------------------------------- dedup
const fp = (o = {}) => ({
  instrumentId: 'VOL75',
  direction: 'bullish',
  poiId: 'poi-a',
  entryPrice: 100000,
  riskDistance: 350,
  ...o,
});

test('dedup: the same POI does not re-fire inside the TTL', () => {
  const d = new AlertDeduplicator({ ttlMinutes: 240, priceTolerance: 0.25 });
  assert.equal(d.isDuplicate(fp()), false);
  d.record(fp());
  assert.equal(d.isDuplicate(fp()), true);
  assert.equal(d.size, 1);
});

test('dedup: the window expires so a setup can fire again much later', () => {
  const d = new AlertDeduplicator({ ttlMinutes: 60, priceTolerance: 0.25 });
  const t0 = 1_700_000_000_000;
  d.record(fp(), t0);
  assert.equal(d.isDuplicate(fp(), t0 + 59 * 60 * 1000), true);
  assert.equal(d.isDuplicate(fp(), t0 + 61 * 60 * 1000), false);
  assert.equal(d.size, 0, 'expired entries are pruned');
});

test('dedup: a different POI at a near-identical entry is still a duplicate', () => {
  const d = new AlertDeduplicator({ ttlMinutes: 240, priceTolerance: 0.25 });
  d.record(fp());
  // 0.25 * 350 = 87.5 points of tolerance
  assert.equal(d.isDuplicate(fp({ poiId: 'poi-b', entryPrice: 100050 })), true);
  assert.equal(d.isDuplicate(fp({ poiId: 'poi-b', entryPrice: 100100 })), false);
});

test('dedup: other instruments and the opposite direction are never suppressed', () => {
  const d = new AlertDeduplicator({ ttlMinutes: 240, priceTolerance: 0.25 });
  d.record(fp());
  assert.equal(d.isDuplicate(fp({ instrumentId: 'VOL50' })), false);
  assert.equal(d.isDuplicate(fp({ direction: 'bearish' })), false);
});

test('dedup: the entry cap keeps memory bounded', () => {
  const d = new AlertDeduplicator({ ttlMinutes: 240, maxEntries: 3, priceTolerance: 0 });
  for (let i = 0; i < 10; i += 1) d.record(fp({ poiId: `poi-${i}`, instrumentId: `I${i}` }));
  assert.equal(d.size, 3);
});

test('dedup: seeding restores the window after a restart', () => {
  const d = new AlertDeduplicator({ ttlMinutes: 240, priceTolerance: 0.25 });
  d.seed([{ key: 'VOL75:bullish:poi-a', instrumentId: 'VOL75', direction: 'bullish', entryPrice: 100000, riskDistance: 350, timestamp: Date.now() }]);
  assert.equal(d.isDuplicate(fp()), true);

  d.clear();
  assert.equal(d.isDuplicate(fp()), false);
  d.seed([null, { instrumentId: 'X' }]); // malformed rows are ignored
  assert.equal(d.size, 0);
});

// ---------------------------------------------------------------- telegram
test('telegram: sends a well-formed request', async () => {
  let captured = null;
  const client = new TelegramClient({
    botToken: 'tok',
    chatId: '42',
    fetchImpl: async (url, init) => {
      captured = { url, body: JSON.parse(init.body), method: init.method };
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 7 } }) };
    },
  });

  const res = await client.sendMessage('<b>hi</b>');
  assert.equal(res[0].message_id, 7);
  assert.equal(captured.url, 'https://api.telegram.org/bottok/sendMessage');
  assert.equal(captured.method, 'POST');
  assert.deepEqual(captured.body, {
    chat_id: '42',
    text: '<b>hi</b>',
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
});

test('telegram: missing credentials fail loudly', async () => {
  const client = new TelegramClient({ botToken: '', chatId: '', fetchImpl: async () => ({}) });
  assert.equal(client.configured, false);
  await assert.rejects(() => client.sendMessage('x'), /must both be set/);
});

test('telegram: retries server errors then succeeds', async () => {
  let calls = 0;
  const client = new TelegramClient({
    botToken: 't',
    chatId: '1',
    retries: 3,
    sleep: async () => {},
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) return { ok: false, status: 503, statusText: 'Service Unavailable', json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
    },
  });
  await client.sendMessage('x');
  assert.equal(calls, 3);
});

test('telegram: a 400 is not retried', async () => {
  let calls = 0;
  const client = new TelegramClient({
    botToken: 't',
    chatId: '1',
    retries: 3,
    sleep: async () => {},
    fetchImpl: async () => {
      calls += 1;
      return { ok: false, status: 400, statusText: 'Bad Request', json: async () => ({ description: 'chat not found' }) };
    },
  });
  await assert.rejects(() => client.sendMessage('x'), /Telegram 400: chat not found/);
  assert.equal(calls, 1);
});

test('telegram: long messages are split on line boundaries', async () => {
  const long = new Array(300).fill('a line of alert text that is fairly long').join('\n');
  const chunks = splitMessage(long, 500);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 500);
  assert.equal(chunks.join('\n'), long, 'nothing is lost in the split');

  let sends = 0;
  const client = new TelegramClient({
    botToken: 't',
    chatId: '1',
    fetchImpl: async () => {
      sends += 1;
      return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
    },
  });
  await client.sendMessage(new Array(6000).fill('x').join(''));
  assert.equal(sends, 2);
});

// ---------------------------------------------------------------- service
test('service: delivers once and suppresses the repeat', async () => {
  const sent = [];
  const service = new AlertService({
    telegram: { sendMessage: async (m) => sent.push(m) },
    dedupOpts: { ttlMinutes: 240, priceTolerance: 0.25 },
    dryRun: false,
  });

  const first = await service.deliver(sampleAlert());
  assert.equal(first.sent, true);
  assert.equal(sent.length, 1);

  const second = await service.deliver(sampleAlert());
  assert.equal(second.sent, false);
  assert.equal(second.skipped, 'duplicate');
  assert.equal(sent.length, 1, 'nothing was sent the second time');
});

test('service: dry-run formats without sending but still de-duplicates', async () => {
  let sends = 0;
  const service = new AlertService({
    telegram: { sendMessage: async () => { sends += 1; } },
    dedupOpts: { ttlMinutes: 240, priceTolerance: 0.25 },
    dryRun: true,
  });
  const res = await service.deliver(sampleAlert());
  assert.equal(res.sent, false);
  assert.equal(res.skipped, 'dry-run');
  assert.match(res.message, /BUY VOL75/);
  assert.equal(sends, 0);
  assert.equal((await service.deliver(sampleAlert())).skipped, 'duplicate');
});

test('service: seeding from persisted records suppresses a restart repeat', async () => {
  const service = new AlertService({
    telegram: { sendMessage: async () => {} },
    dedupOpts: { ttlMinutes: 240, priceTolerance: 0.25 },
    dryRun: false,
  });
  service.seedFrom([
    {
      instrumentId: 'VOL75',
      direction: 'bullish',
      poiId: '30m:OB:bullish:1700000000:99900:100100',
      entryPrice: 100000,
      riskDistance: 350,
      createdAt: new Date().toISOString(),
    },
  ]);
  assert.equal((await service.deliver(sampleAlert())).skipped, 'duplicate');
});
