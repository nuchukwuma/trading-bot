'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { aggregateCandles, ticksToCandles, dropForming } = require('../src/data/aggregation');
const { OandaConnector } = require('../src/data/oandaConnector');
const { DerivConnector } = require('../src/data/derivConnector');
const { MarketDataService } = require('../src/data');
const { series, c } = require('./helpers/candles');

const H4 = 14400;
const M30 = 1800;

test('aggregation: 30m candles fold into a 4H candle with correct OHLC', () => {
  // 8 x 30m candles = one full 4H bucket starting at a 4H boundary.
  const start = 1700000000 - (1700000000 % H4);
  const src = series(
    [
      [10, 11, 9, 10.5],
      [10.5, 12, 10, 11],
      [11, 11.5, 7, 8], // lowest low
      [8, 9, 7.5, 8.5],
      [8.5, 14, 8, 13], // highest high
      [13, 13.5, 12, 12.5],
      [12.5, 13, 12, 12.8],
      [12.8, 13, 12.5, 12.9], // close of the bucket
    ],
    { start, tf: M30 }
  );

  const [h4] = aggregateCandles(src, H4, { now: start + H4 + 1 });
  assert.equal(h4.time, start);
  assert.equal(h4.open, 10);
  assert.equal(h4.high, 14);
  assert.equal(h4.low, 7);
  assert.equal(h4.close, 12.9);
});

test('aggregation: incomplete trailing bucket is dropped by default', () => {
  const start = 1700000000 - (1700000000 % H4);
  const src = series(
    [
      [10, 11, 9, 10.5],
      [10.5, 12, 10, 11],
    ],
    { start, tf: M30 }
  );
  // "now" is only 1h into the 4H bucket -> nothing closed yet.
  const out = aggregateCandles(src, H4, { now: start + 3600 });
  assert.equal(out.length, 0);

  const kept = aggregateCandles(src, H4, { now: start + H4, dropIncomplete: true });
  assert.equal(kept.length, 1, 'bucket is complete exactly at its end boundary');
});

test('aggregation: volume is summed across the bucket', () => {
  const start = 0;
  const src = [c(0, 1, 2, 0, 1, 5), c(1800, 1, 2, 0, 1, 7)];
  const [out] = aggregateCandles(src, H4, { now: H4 + 1 });
  assert.equal(out.volume, 12);
});

test('aggregation: ticks fold into candles', () => {
  const ticks = [
    { epoch: 0, quote: 100 },
    { epoch: 10, quote: 105 },
    { epoch: 20, quote: 95 },
    { epoch: 59, quote: 101 },
    { epoch: 60, quote: 200 },
  ];
  const out = ticksToCandles(ticks, 60, { now: 1000 });
  assert.equal(out.length, 2);
  assert.deepEqual(
    { o: out[0].open, h: out[0].high, l: out[0].low, cl: out[0].close, v: out[0].volume },
    { o: 100, h: 105, l: 95, cl: 101, v: 4 }
  );
  assert.equal(out[1].open, 200);
});

test('aggregation: dropForming removes an unclosed final candle', () => {
  const s = series([[1, 2, 0, 1], [1, 2, 0, 1]], { start: 0, tf: M30 });
  assert.equal(dropForming(s, M30, M30 + 600).length, 1, 'last candle still forming');
  assert.equal(dropForming(s, M30, 2 * M30 + 1).length, 2, 'both candles closed');
});

test('oanda connector: maps mid candles, drops incomplete, requests right params', async () => {
  let calledUrl = null;
  let calledHeaders = null;
  const fakeFetch = async (url, init) => {
    calledUrl = url;
    calledHeaders = init.headers;
    return {
      ok: true,
      json: async () => ({
        candles: [
          { time: '1700000000.000', complete: true, volume: 3, mid: { o: '1.1000', h: '1.1050', l: '1.0990', c: '1.1020' } },
          { time: '1700001800.000', complete: true, volume: 4, mid: { o: '1.1020', h: '1.1080', l: '1.1010', c: '1.1070' } },
          { time: '1700003600.000', complete: false, volume: 1, mid: { o: '1.1070', h: '1.1090', l: '1.1060', c: '1.1080' } },
        ],
      }),
    };
  };

  const oanda = new OandaConnector({ apiKey: 'test-key', fetchImpl: fakeFetch });
  const out = await oanda.fetchCandles('EUR_USD', M30, 200);

  assert.equal(out.length, 2, 'incomplete candle is not returned');
  assert.deepEqual(out[0], { time: 1700000000, open: 1.1, high: 1.105, low: 1.099, close: 1.102, volume: 3 });
  assert.match(calledUrl, /granularity=M30/);
  assert.match(calledUrl, /count=200/);
  assert.match(calledUrl, /price=M/);
  assert.equal(calledHeaders.Authorization, 'Bearer test-key');
});

test('oanda connector: aggregates locally for a non-native timeframe', async () => {
  const start = 1700000000 - (1700000000 % (3 * 3600));
  const raw = [];
  for (let i = 0; i < 6; i += 1) {
    raw.push({
      time: `${start + i * M30}.000`,
      complete: true,
      volume: 1,
      mid: { o: '1.0', h: String(1.0 + i / 100), l: '0.9', c: '1.05' },
    });
  }
  const oanda = new OandaConnector({
    apiKey: 'k',
    fetchImpl: async () => ({ ok: true, json: async () => ({ candles: raw }) }),
  });
  const out = await oanda.fetchCandles('EUR_USD', 3 * 3600, 5); // 3H has no native code
  assert.equal(out.length, 1);
  assert.equal(out[0].high, 1.05);
});

test('oanda connector: surfaces HTTP errors and missing credentials', async () => {
  const bad = new OandaConnector({
    apiKey: 'k',
    fetchImpl: async () => ({ ok: false, status: 401, statusText: 'Unauthorized', text: async () => 'nope' }),
  });
  await assert.rejects(() => bad.fetchCandles('EUR_USD', M30, 10), /OANDA 401/);

  const unset = new OandaConnector({ apiKey: '', fetchImpl: async () => ({}) });
  assert.equal(unset.configured, false);
  await assert.rejects(() => unset.fetchCandles('EUR_USD', M30, 10), /OANDA_API_KEY is not set/);
});

test('deriv connector: rejects unsupported granularities before opening a socket', async () => {
  const deriv = new DerivConnector();
  await assert.rejects(() => deriv.fetchCandles('R_75', 1234, 10), /does not support/);
});

test('deriv connector: maps ticks_history candle payloads', async () => {
  const deriv = new DerivConnector();
  // Stub the request layer — the socket itself is exercised in integration, not unit tests.
  deriv.send = async (payload) => {
    assert.equal(payload.ticks_history, 'R_75');
    assert.equal(payload.granularity, M30);
    assert.equal(payload.style, 'candles');
    return {
      candles: [
        { epoch: 1700000000, open: '100.5', high: '101', low: '100', close: '100.9' },
        { epoch: 1700001800, open: '100.9', high: '102', low: '100.8', close: '101.7' },
      ],
    };
  };
  const out = await deriv.fetchCandles('R_75', M30, 2);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { time: 1700000000, open: 100.5, high: 101, low: 100, close: 100.9, volume: 0 });
});

test('market data service: routes instruments to the right connector and caches', async () => {
  const calls = [];
  const fakeDeriv = {
    fetchCandles: async (symbol, tf, count) => {
      calls.push(['deriv', symbol, tf, count]);
      return series([[1, 2, 0, 1]], { start: 1700000000, tf });
    },
    close() {},
  };
  const fakeOanda = {
    fetchCandles: async (symbol, tf, count) => {
      calls.push(['oanda', symbol, tf, count]);
      return series([[1, 2, 0, 1]], { start: 1700000000, tf });
    },
    close() {},
  };
  const svc = new MarketDataService({ deriv: fakeDeriv, oanda: fakeOanda });

  await svc.getCandles({ id: 'VOL75', source: 'deriv', symbol: 'R_75' }, M30, 10);
  await svc.getCandles({ id: 'EURUSD', source: 'oanda', symbol: 'EUR_USD' }, M30, 10);
  assert.deepEqual(calls, [
    ['deriv', 'R_75', M30, 10],
    ['oanda', 'EUR_USD', M30, 10],
  ]);

  assert.throws(
    () => svc.connectorFor({ id: 'X', source: 'bogus' }),
    /Unknown data source/
  );
});

test('market data service: fetches both timeframes together', async () => {
  const fake = {
    fetchCandles: async (symbol, tf) => series([[1, 2, 0, 1]], { start: 1700000000, tf }),
    close() {},
  };
  const svc = new MarketDataService({ deriv: fake, oanda: fake });
  const { htf, ltf } = await svc.getBiasAndEntryCandles(
    { id: 'VOL75', source: 'deriv', symbol: 'R_75' },
    { htfSeconds: H4, ltfSeconds: M30, htfCount: 10, ltfCount: 10 }
  );
  assert.equal(htf.length, 1);
  assert.equal(ltf.length, 1);
});

test('deriv: public endpoint by default, app id only on a custom URL', () => {
  const pub = 'wss://api.derivws.com/trading/v1/options/ws/public';
  assert.equal(new DerivConnector({ wsUrl: pub, appId: '' }).url, pub);
  assert.equal(new DerivConnector({ wsUrl: pub, appId: '1089' }).url, pub, 'a stale app id is not sent to the public endpoint');
  assert.equal(new DerivConnector({ wsUrl: 'wss://x.example/v3', appId: 'abc' }).url, 'wss://x.example/v3?app_id=abc');
});

test('deriv: an idle close does not reconnect; one with requests in flight does', () => {
  const EventEmitter = require('events');
  const sockets = [];
  class FakeWs extends EventEmitter {
    constructor() {
      super();
      this.readyState = 0;
      sockets.push(this);
    }
    send() {}
    close() {}
  }
  const deriv = new DerivConnector({ WebSocketImpl: FakeWs, reconnectDelayMs: 60000 });
  let scheduled = 0;
  deriv._scheduleReconnect = () => (scheduled += 1);

  deriv.connect();
  sockets[0].readyState = 1;
  sockets[0].emit('open');
  sockets[0].emit('close');
  assert.equal(scheduled, 0, 'idle close is left alone');

  deriv.connect();
  sockets[1].readyState = 1;
  sockets[1].emit('open');
  deriv.pending.set(1, { resolve() {}, reject() {}, timer: null });
  sockets[1].emit('close');
  assert.equal(scheduled, 1, 'an interrupted request triggers a reconnect');
  assert.equal(deriv.pending.size, 0);
});

test('deriv: fetchHistory pages backwards until it covers the range', async () => {
  const deriv = new DerivConnector();
  const requests = [];
  // A feed with 30m candles from t=0 to t=30000*1800, 5 per page.
  deriv.send = async (p) => {
    requests.push(p.end);
    const lastBar = Math.floor(p.end / 1800) * 1800; // every bar opened by `end`, forming one included
    const candles = [];
    for (let t = lastBar - (p.count - 1) * 1800; t <= lastBar; t += 1800) {
      if (t >= 0) candles.push({ epoch: t, open: 1, high: 2, low: 0.5, close: 1.5 });
    }
    return { candles };
  };
  const to = 100 * 1800;
  const out = await deriv.fetchHistory('R_75', 1800, { from: 80 * 1800, to, pageSize: 5 });
  assert.equal(out[0].time, 80 * 1800);
  assert.equal(out.at(-1).time, 99 * 1800);
  assert.equal(new Set(out.map((c) => c.time)).size, out.length, 'no duplicates across pages');
  assert.ok(requests.length >= 4, 'several pages were needed');
  for (let i = 1; i < out.length; i += 1) assert.equal(out[i].time - out[i - 1].time, 1800);
});
