'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseHours, inWindow, startServer, startKeepAwake } = require('../src/server');

test('server: parseHours reads day, overnight and all-day windows', () => {
  assert.deepEqual(parseHours('6-22'), { start: 6, end: 22 });
  assert.deepEqual(parseHours(' 22 - 6 '), { start: 22, end: 6 });
  assert.equal(parseHours(''), null);
  assert.equal(parseHours('always'), null);
  assert.equal(parseHours('0-24'), null);
  assert.throws(() => parseHours('6am-10pm'));
  assert.throws(() => parseHours('25-3'));
});

test('server: inWindow respects the time zone and wraps overnight', () => {
  // 05:30 UTC = 06:30 in Lagos (UTC+1, no DST)
  const t = new Date('2026-09-25T05:30:00Z');
  assert.equal(inWindow(t, { start: 6, end: 22 }, 'UTC'), false);
  assert.equal(inWindow(t, { start: 6, end: 22 }, 'Africa/Lagos'), true);
  const late = new Date('2026-09-25T22:30:00Z'); // 23:30 Lagos
  assert.equal(inWindow(late, { start: 6, end: 22 }, 'Africa/Lagos'), false);
  assert.equal(inWindow(late, { start: 22, end: 6 }, 'Africa/Lagos'), true);
  assert.equal(inWindow(late, null, 'Africa/Lagos'), true);
});

test('server: keep-awake pings only inside the window', async () => {
  const calls = [];
  let now = new Date('2026-09-25T10:00:00Z'); // 11:00 Lagos
  const ka = startKeepAwake({
    url: 'https://bot.example.com/',
    intervalMs: 60000,
    window: { start: 6, end: 22 },
    tz: 'Africa/Lagos',
    fetchFn: async (u) => {
      calls.push(u);
      return { status: 200 };
    },
    now: () => now,
  });
  await ka.tick();
  now = new Date('2026-09-25T23:00:00Z'); // 00:00 Lagos
  await ka.tick();
  ka.stop();
  assert.deepEqual(calls, ['https://bot.example.com/healthz']);
});

test('server: serves health and status', async () => {
  const server = startServer({ port: 0, getStatus: () => ({ scans: 3 }) });
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), 'ok');
    const status = await (await fetch(`${base}/`)).json();
    assert.equal(status.ok, true);
    assert.equal(status.scans, 3);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  } finally {
    server.close();
  }
});
