'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PaperAccount,
  quoteLine,
  resultLine,
  formatAccount,
  simulateAccount,
  formatWhatIf,
  formatHistory,
  parseRisk,
} = require('../src/paper/account');

function memoryDb() {
  const settings = new Map();
  const txns = [];
  return {
    settings,
    txns,
    getSetting: async (k) => (settings.has(k) ? JSON.parse(JSON.stringify(settings.get(k))) : undefined),
    setSetting: async (k, v) => settings.set(k, JSON.parse(JSON.stringify(v))),
    addPaperTxn: async (t) => txns.push({ ...t, createdAt: new Date('2026-11-10T10:00:00Z') }),
  };
}

const win = (r) => ({ status: 'tp2', rMultiple: r, filled: true });
const loss = { status: 'stopped', rMultiple: -1, filled: true };
const noFill = { status: 'expired', rMultiple: 0, filled: false, invalidReason: 'no_fill' };

test('demo: deposit and withdraw move the balance; open risk cannot be withdrawn', async () => {
  const acct = new PaperAccount({ db: memoryDb() });
  assert.equal(acct.funded, false);
  assert.equal(await acct.deposit(20), 20);
  await acct.open('a1', { instrumentId: 'EURUSD', side: 'BUY' }); // $3 at risk
  assert.equal(acct.committed(), 3);
  assert.equal(acct.free(), 17);
  await assert.rejects(() => acct.withdraw(18), /Only \$17\.00 is free/);
  assert.equal(await acct.withdraw(7), 13);
  assert.equal(acct.state.withdrawn, 7);
  await assert.rejects(() => acct.deposit(0), /more than/);
});

test('demo: wins and losses settle at R x risk; a setup that never fills costs nothing', async () => {
  const acct = new PaperAccount({ db: memoryDb() });
  await acct.deposit(100);
  await acct.open('w', { instrumentId: 'EURUSD', side: 'BUY' });
  await acct.open('l', { instrumentId: 'VOL75', side: 'SELL' });
  await acct.open('n', { instrumentId: 'GBPUSD', side: 'BUY' });

  const w = await acct.close('w', win(2.5));
  assert.equal(w.pnl, 7.5);
  const l = await acct.close('l', loss);
  assert.equal(l.pnl, -3);
  const n = await acct.close('n', noFill);
  assert.equal(n.pnl, 0);
  assert.equal(n.filled, false);

  assert.equal(acct.state.balance, 104.5);
  assert.equal(acct.state.realized, 4.5);
  assert.deepEqual([acct.state.wins, acct.state.losses, acct.state.notFilled], [1, 1, 1]);
  assert.equal(acct.committed(), 0);
  assert.equal(await acct.close('never-taken', win(2)), null, 'alerts the account did not take are ignored');
});

test('demo: when the cash runs out it sits trades out, then resumes after a deposit', async () => {
  const acct = new PaperAccount({ db: memoryDb() });
  await acct.deposit(5); // $3 per trade
  assert.equal((await acct.open('t1', { instrumentId: 'EURUSD', side: 'BUY' })).take, true);
  const skipped = await acct.open('t2', { instrumentId: 'GBPUSD', side: 'BUY' }); // only $2 free
  assert.equal(skipped.take, false);
  assert.equal(acct.state.skipped, 1);
  assert.match(quoteLine(acct.quote()), /sits this one out: \$2\.00 free, \$3\.00 needed/);

  const r = await acct.close('t1', loss); // balance 2
  assert.equal(r.balance, 2);
  assert.equal(r.exhausted, true);
  assert.match(resultLine(r), /−\$3\.00 → balance \$2\.00[\s\S]*Demo cash used up[\s\S]*Alerts keep coming/);

  await acct.deposit(10);
  assert.equal(acct.quote().take, true, 'taking trades again after a deposit');
});

test('demo: an empty account never takes trades and says how to start', async () => {
  const acct = new PaperAccount({ db: memoryDb() });
  const q = await acct.open('x', { instrumentId: 'EURUSD', side: 'BUY' });
  assert.equal(q.take, false);
  assert.equal(acct.state.skipped, 0, 'not counted as skipped before any deposit');
  assert.match(quoteLine(q), /empty — \/deposit 20/);
  assert.match(formatAccount(acct), /empty/);
});

test('demo: percent risk scales with the balance', async () => {
  const acct = new PaperAccount({ db: memoryDb() });
  await acct.deposit(20);
  await acct.setRisk('percent', 2);
  assert.equal(acct.riskPerTrade(), 0.4);
  await acct.open('a', { instrumentId: 'EURUSD', side: 'BUY' });
  await acct.close('a', win(3)); // +1.20
  assert.equal(acct.state.balance, 21.2);
  assert.equal(acct.riskPerTrade(), 0.42);
  await assert.rejects(() => acct.setRisk('percent', 150), /at most 100%/);
  assert.deepEqual(parseRisk('2%'), { mode: 'percent', value: 2 });
  assert.deepEqual(parseRisk('$1.5'), { mode: 'fixed', value: 1.5 });
  assert.equal(parseRisk('abc'), null);
});

test('demo: the account survives a restart, open trades included', async () => {
  const db = memoryDb();
  const a = new PaperAccount({ db });
  await a.deposit(50);
  await a.open('open1', { instrumentId: 'VOL75', side: 'SELL' });
  const b = await new PaperAccount({ db }).load();
  assert.equal(b.state.balance, 50);
  assert.ok(b.state.open.open1);
  const r = await b.close('open1', win(2));
  assert.equal(r.balance, 56);
});

test('demo: two results arriving together are applied one after the other', async () => {
  const acct = new PaperAccount({ db: memoryDb() });
  await acct.deposit(100);
  await acct.open('a', { instrumentId: 'EURUSD', side: 'BUY' });
  await acct.open('b', { instrumentId: 'GBPUSD', side: 'BUY' });
  await Promise.all([acct.close('a', win(2)), acct.close('b', loss)]);
  assert.equal(acct.state.balance, 103);
});

test('demo: drawdown tracks the deepest drop from a high, and a withdrawal is not a drop', async () => {
  const acct = new PaperAccount({ db: memoryDb() });
  await acct.deposit(30);
  for (const id of ['1', '2', '3']) await acct.open(id, { instrumentId: 'EURUSD', side: 'BUY' });
  await acct.close('1', win(2)); // 36
  await acct.close('2', loss); // 33
  await acct.close('3', loss); // 30
  assert.equal(acct.state.maxDrawdown, 6);
  await acct.withdraw(10);
  assert.equal(acct.state.maxDrawdown, 6, 'unchanged by the withdrawal');
});

test('demo: /account shows balance, equity with open trades, and the record', async () => {
  const acct = new PaperAccount({ db: memoryDb() });
  await acct.deposit(20);
  await acct.open('a', { instrumentId: 'EURUSD', side: 'BUY' });
  await acct.open('b', { instrumentId: 'VOL75', side: 'SELL' });
  const text = formatAccount(acct, [
    { _id: 'a', progress: { filled: true, currentR: 1.5 } },
    { _id: 'b', progress: { filled: false } },
  ]);
  assert.match(text, /Balance \$20\.00 · equity \$24\.50 \(open trades \+\$4\.50\)/);
  assert.match(text, /BUY EURUSD — \$3\.00 risk, \+\$4\.50 now/);
  assert.match(text, /SELL VOL75 — \$3\.00 risk, waiting for entry/);
  assert.match(text, /\$6\.00 at risk/);
});

test('whatif: replays closed alerts on a starting balance, skipping what it cannot afford', () => {
  const doc = (i, status, r) => ({ outcome: { status, rMultiple: r, closedAt: new Date(1700000000000 + i * 1000) } });
  const docs = [doc(1, 'stopped', -1), doc(2, 'stopped', -1), doc(3, 'tp2', 2.5), doc(4, 'expired', 0), doc(5, 'stopped', -1)];
  const small = simulateAccount(docs, { start: 5, mode: 'fixed', value: 3 });
  // 5 -> 2 (loss) -> cannot afford $3: the rest are skipped
  assert.equal(small.end, 2);
  assert.equal(small.skipped, 4);
  const big = simulateAccount(docs, { start: 100, mode: 'fixed', value: 3 });
  assert.equal(big.end, 100 - 3 - 3 + 7.5 - 3);
  assert.deepEqual([big.wins, big.losses, big.notFilled], [1, 3, 1]);
  assert.match(formatWhatIf(big, { days: 30, mode: 'fixed', value: 3 }), /\$100\.00 → <b>\$98\.50<\/b> \(−\$1\.50, −1\.5%\)/);
  assert.match(formatWhatIf(simulateAccount([], { start: 20 }), { days: 7 }), /nothing to replay/);
});

test('history: lists deposits, results and skips with the balance after each', async () => {
  const db = memoryDb();
  const acct = new PaperAccount({ db });
  await acct.deposit(5);
  await acct.open('a', { instrumentId: 'EURUSD', side: 'BUY' });
  await acct.open('b', { instrumentId: 'GBPUSD', side: 'BUY' });
  await acct.close('a', win(2));
  const text = formatHistory(db.txns.filter((t) => t.type !== 'open').reverse());
  assert.match(text, /EURUSD \+\$6\.00 — tp2 2\.00R on \$3\.00 risk → \$11\.00/);
  assert.match(text, /GBPUSD skipped — \$2\.00 free, \$3\.00 needed/);
  assert.match(text, /deposit \$5\.00 → \$5\.00/);
});
