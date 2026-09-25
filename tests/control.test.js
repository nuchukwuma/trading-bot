'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { AlertSettings } = require('../src/control/settings');
const { TelegramControl } = require('../src/control/telegramBot');

const INSTRUMENTS = [
  { id: 'EURUSD', displayName: 'EUR/USD' },
  { id: 'GBPUSD', displayName: 'GBP/USD' },
  { id: 'VOL75', displayName: 'Volatility 75 Index' },
];

function memoryDb() {
  const store = new Map();
  return { store, getSetting: async (k) => store.get(k), setSetting: async (k, v) => store.set(k, v) };
}

function build({ chatId = '42' } = {}) {
  const settings = new AlertSettings({ instruments: INSTRUMENTS, db: memoryDb() });
  const sent = [];
  const calls = [];
  const telegram = {
    sendMessage: async (text, extra = {}) => sent.push({ text, ...extra }),
    call: async (method, payload) => {
      calls.push({ method, payload });
      return true;
    },
  };
  const control = new TelegramControl({
    telegram,
    settings,
    chatId,
    getStatus: () => ({ lastScanAt: '2026-09-25T14:00:15.000Z', nextScanAt: null, scans: 2, database: true }),
    runScan: async () => [{ fired: true }, { stage: 'muted' }, { stage: 'error', instrumentId: 'VOL75', reason: 'x' }],
  });
  const say = (text, chat = 42) => control.handleUpdate({ message: { text, chat: { id: chat } } });
  return { settings, control, sent, calls, say };
}

test('settings: find accepts ids and display names in any case', () => {
  const s = new AlertSettings({ instruments: INSTRUMENTS });
  assert.equal(s.find('eurusd').id, 'EURUSD');
  assert.equal(s.find('GBP/USD').id, 'GBPUSD');
  assert.equal(s.find('vol75').id, 'VOL75');
  assert.equal(s.find('nope'), null);
});

test('settings: choices survive a restart through the database', async () => {
  const db = memoryDb();
  const a = new AlertSettings({ instruments: INSTRUMENTS, db });
  await a.setEnabled('VOL75', false);
  await a.setPaused(true);
  const b = await new AlertSettings({ instruments: INSTRUMENTS, db }).load();
  assert.equal(b.isEnabled('VOL75'), false);
  assert.equal(b.paused, true);
  assert.equal(b.shouldAlert('EURUSD'), false, 'paused overrides a pair being on');
});

test('control: /off, /on and /only change which pairs alert', async () => {
  const { settings, sent, say } = build();
  await say('/off vol75 gbpusd');
  assert.deepEqual(settings.enabledIds(), ['EURUSD']);
  assert.match(sent.at(-1).text, /Off: VOL75, GBPUSD/);

  await say('/on GBP/USD');
  assert.deepEqual(settings.enabledIds(), ['EURUSD', 'GBPUSD']);

  await say('/only VOL75');
  assert.deepEqual(settings.enabledIds(), ['VOL75']);

  await say('/off BTCUSD');
  assert.match(sent.at(-1).text, /Not recognised: BTCUSD/);

  await say('/all');
  assert.equal(settings.enabledIds().length, 3);
});

test('control: /pause and /resume', async () => {
  const { settings, say } = build();
  await say('/pause');
  assert.equal(settings.paused, true);
  await say('/resume');
  assert.equal(settings.paused, false);
});

test('control: commands from any other chat are ignored', async () => {
  const { settings, sent, say } = build();
  await say('/off EURUSD', 999);
  assert.equal(settings.isEnabled('EURUSD'), true);
  assert.equal(sent.length, 0);
});

test('control: /pairs buttons toggle a pair and redraw the keyboard', async () => {
  const { settings, control, sent, calls, say } = build();
  await say('/pairs');
  const keyboard = sent.at(-1).replyMarkup.inline_keyboard;
  assert.equal(keyboard.flat().find((b) => b.callback_data === 't:VOL75').text, '✅ VOL75');

  await control.handleUpdate({
    callback_query: { id: 'q1', data: 't:VOL75', message: { chat: { id: 42 }, message_id: 7 } },
  });
  assert.equal(settings.isEnabled('VOL75'), false);
  const edit = calls.find((c) => c.method === 'editMessageText');
  assert.equal(edit.payload.reply_markup.inline_keyboard.flat().find((b) => b.callback_data === 't:VOL75').text, '⬜️ VOL75');

  await control.handleUpdate({
    callback_query: { id: 'q2', data: 'all:off', message: { chat: { id: 42 }, message_id: 7 } },
  });
  assert.equal(settings.enabledIds().length, 0);
});

test('control: a button press from another chat changes nothing', async () => {
  const { settings, control } = build();
  await control.handleUpdate({
    callback_query: { id: 'q1', data: 't:VOL75', message: { chat: { id: 1 }, message_id: 7 } },
  });
  assert.equal(settings.isEnabled('VOL75'), true);
});

test('control: /status and /scan report back', async () => {
  const { sent, say } = build();
  await say('/status');
  assert.match(sent.at(-1).text, /Last scan: 2026-09-25 14:00 UTC \(2 since start\)/);
  await say('/scan');
  const done = sent.at(-1).text;
  assert.match(done, /1 alert\(s\) sent from 3 pair\(s\)/);
  assert.match(done, /1 setup\(s\) on pairs that are off/);
  assert.match(done, /VOL75 \(x\)/);
});
