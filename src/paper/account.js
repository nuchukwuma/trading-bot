'use strict';

const config = require('../config');
const { createLogger } = require('../util/logger');

const log = createLogger('paper');

const KEY = 'paperAccount';
const cents = (n) => Math.round(n * 100) / 100;
const usd = (n) => `${n < 0 ? '−' : ''}$${Math.abs(cents(n)).toFixed(2)}`;
const signedUsd = (n) => `${n >= 0 ? '+' : '−'}$${Math.abs(cents(n)).toFixed(2)}`;
const signedPct = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`;

/**
 * The demo account: play money that follows the bot's own alerts.
 *
 * Every alert SENT while the account has enough free cash is "taken" at the
 * account's risk per trade; its result (R x that risk) lands on the balance
 * when the tracker resolves it. A setup whose entry never fills costs nothing.
 *
 * Money at risk in open trades is set aside, so the account can never lose
 * more than it holds. When there is not enough free cash for the next trade
 * the account sits it out and says so — signals keep being sent and tracked
 * regardless, and the account picks up again after the next /deposit.
 *
 * Results follow each plan exactly as sent (limit fill, partials, stop moves)
 * and include no spread or commission.
 */
class PaperAccount {
  constructor({ db = null } = {}) {
    this.db = db;
    this.state = PaperAccount.fresh();
    this.queue = Promise.resolve();
  }

  static fresh() {
    return {
      balance: 0,
      deposited: 0,
      withdrawn: 0,
      realized: 0,
      riskMode: 'fixed', // 'fixed' $ per trade, or 'percent' of balance
      riskValue: config.risk.riskPerTrade,
      wins: 0,
      losses: 0,
      flat: 0,
      notFilled: 0,
      skipped: 0,
      peak: 0,
      maxDrawdown: 0,
      open: {}, // alertId -> { risk, instrumentId, side, openedAt }
      createdAt: new Date().toISOString(),
    };
  }

  /** Run state changes one at a time, so two results never race. */
  serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async load() {
    if (!this.db) return this;
    try {
      const saved = await this.db.getSetting(KEY);
      if (saved) this.state = { ...PaperAccount.fresh(), ...saved, open: saved.open || {} };
    } catch (err) {
      log.warn(`could not load the demo account: ${err.message}`);
    }
    return this;
  }

  async save() {
    if (!this.db) return;
    await this.db.setSetting(KEY, this.state).catch((err) => log.error(`could not save the demo account: ${err.message}`));
  }

  async txn(t) {
    if (!this.db || !this.db.addPaperTxn) return;
    await this.db.addPaperTxn({ ...t, balanceAfter: cents(this.state.balance) }).catch(() => {});
  }

  committed() {
    return cents(Object.values(this.state.open).reduce((a, t) => a + t.risk, 0));
  }

  free() {
    return cents(this.state.balance - this.committed());
  }

  riskPerTrade() {
    const s = this.state;
    return s.riskMode === 'percent' ? cents((s.balance * s.riskValue) / 100) : cents(s.riskValue);
  }

  get funded() {
    return this.state.deposited > 0 || this.state.balance > 0;
  }

  /** Would the account take a trade right now, and at what risk? */
  quote() {
    const risk = this.riskPerTrade();
    const free = this.free();
    if (!this.funded) return { take: false, risk, free, balance: this.state.balance, reason: 'empty' };
    if (risk < 0.01 || free + 1e-9 < risk) return { take: false, risk, free, balance: this.state.balance, reason: 'insufficient' };
    return { take: true, risk, free, balance: this.state.balance };
  }

  /** Called once a sent alert is stored. Takes it if the cash is there. */
  open(alertId, { instrumentId, side }) {
    return this.serial(async () => {
      const q = this.quote();
      if (!q.take) {
        if (this.funded) {
          this.state.skipped += 1;
          await this.save();
          await this.txn({ type: 'skip', amount: 0, alertId, instrumentId, note: `${usd(q.free)} free, ${usd(q.risk)} needed` });
        }
        return q;
      }
      this.state.open[alertId] = { risk: q.risk, instrumentId, side, openedAt: new Date().toISOString() };
      await this.save();
      await this.txn({ type: 'open', amount: q.risk, alertId, instrumentId, note: `${side} risking ${usd(q.risk)}` });
      return q;
    });
  }

  /**
   * Called when the tracker resolves an alert. Returns null if the account
   * never took it, else { pnl, balance, exhausted, filled }.
   */
  close(alertId, outcome) {
    return this.serial(async () => {
      const trade = this.state.open[alertId];
      if (!trade) return null;
      delete this.state.open[alertId];
      const s = this.state;
      const filled = outcome.filled !== false && !['expired', 'cancelled'].includes(outcome.status);
      const pnl = filled ? cents((outcome.rMultiple || 0) * trade.risk) : 0;

      s.balance = cents(s.balance + pnl);
      s.realized = cents(s.realized + pnl);
      if (!filled) s.notFilled += 1;
      else if (pnl > 0) s.wins += 1;
      else if (pnl < 0) s.losses += 1;
      else s.flat += 1;
      s.peak = Math.max(s.peak, s.balance);
      if (s.peak > 0) s.maxDrawdown = Math.max(s.maxDrawdown, cents(s.peak - s.balance));

      await this.save();
      await this.txn({
        type: 'result',
        amount: pnl,
        alertId,
        instrumentId: trade.instrumentId,
        note: filled ? `${outcome.status} ${(outcome.rMultiple || 0).toFixed(2)}R on ${usd(trade.risk)} risk` : 'entry never filled — no trade',
      });
      const next = this.quote();
      return { pnl, balance: s.balance, filled, exhausted: this.funded && !next.take, free: next.free, nextRisk: next.risk };
    });
  }

  deposit(amount) {
    return this.serial(async () => {
      const a = cents(amount);
      if (!(a > 0)) throw new Error('Deposit must be more than $0');
      this.state.balance = cents(this.state.balance + a);
      this.state.deposited = cents(this.state.deposited + a);
      this.state.peak = Math.max(this.state.peak, this.state.balance);
      await this.save();
      await this.txn({ type: 'deposit', amount: a });
      return this.state.balance;
    });
  }

  withdraw(amount) {
    return this.serial(async () => {
      const a = cents(amount);
      if (!(a > 0)) throw new Error('Withdrawal must be more than $0');
      const free = this.free();
      if (a > free + 1e-9) throw new Error(`Only ${usd(free)} is free — ${usd(this.committed())} is at risk in open trades`);
      this.state.balance = cents(this.state.balance - a);
      this.state.withdrawn = cents(this.state.withdrawn + a);
      // A withdrawal is not a loss: reset the high-water mark to the new balance.
      this.state.peak = Math.min(this.state.peak, this.state.balance);
      await this.save();
      await this.txn({ type: 'withdraw', amount: -a });
      return this.state.balance;
    });
  }

  setRisk(mode, value) {
    return this.serial(async () => {
      if (!['fixed', 'percent'].includes(mode) || !(value > 0)) throw new Error('Risk must be more than 0');
      if (mode === 'percent' && value > 100) throw new Error('Risk can be at most 100% of the balance');
      this.state.riskMode = mode;
      this.state.riskValue = value;
      await this.save();
      await this.txn({ type: 'risk', amount: 0, note: describeRisk(this.state) });
    });
  }

  reset() {
    return this.serial(async () => {
      this.state = PaperAccount.fresh();
      await this.save();
    });
  }
}

const describeRisk = (s) => (s.riskMode === 'percent' ? `${s.riskValue}% of the balance per trade` : `${usd(s.riskValue)} per trade`);

/** The line added to an alert about the demo account. */
function quoteLine(q) {
  if (!q) return null;
  if (q.reason === 'empty') return '📒 <i>Demo account is empty — /deposit 20 to follow these alerts with demo cash.</i>';
  if (!q.take) return `📒 <i>Demo account sits this one out: ${usd(q.free)} free, ${usd(q.risk)} needed. /deposit to continue.</i>`;
  return `📒 <i>Demo account: risking ${usd(q.risk)} of ${usd(q.balance)} (${usd(q.free - q.risk)} free after this)</i>`;
}

/** The line added to a trade's final update. */
function resultLine(r) {
  if (!r) return null;
  const lines = [
    r.filled
      ? `📒 Demo account: ${signedUsd(r.pnl)} → balance ${usd(r.balance)}`
      : `📒 Demo account: no fill, nothing lost — balance ${usd(r.balance)}`,
  ];
  if (r.exhausted) {
    lines.push(
      `⚠️ Demo cash used up: ${usd(r.free)} free, ${usd(r.nextRisk)} needed per trade. Alerts keep coming and being tracked — /deposit to start taking them again.`
    );
  }
  return lines.join('\n');
}

/** /account */
function formatAccount(account, openDocs = []) {
  const s = account.state;
  if (!account.funded) {
    return [
      '📒 <b>Demo account</b> — empty',
      'Deposit demo cash to see what following the alerts would do to a real account:',
      '/deposit 20 · /deposit 100',
      `It risks ${describeRisk(s)} unless you change it (/risk 2% or /risk 1).`,
    ].join('\n');
  }
  const netIn = s.deposited - s.withdrawn;
  const live = openDocs.filter((d) => s.open[String(d._id)]);
  const running = live.reduce((a, d) => a + ((d.progress && d.progress.filled && d.progress.currentR) || 0) * s.open[String(d._id)].risk, 0);
  const traded = s.wins + s.losses + s.flat;
  const lines = [
    '📒 <b>Demo account</b>',
    `Balance ${usd(s.balance)} · equity ${usd(s.balance + running)} (open trades ${signedUsd(running)})`,
    `Deposited ${usd(s.deposited)} · withdrawn ${usd(s.withdrawn)}`,
    `Profit ${signedUsd(s.realized)}${netIn > 0 ? ` (${signedPct(s.realized / netIn)} on cash put in)` : ''}`,
    traded
      ? `Trades ${traded}: won ${s.wins}, lost ${s.losses}${s.flat ? `, breakeven ${s.flat}` : ''} (${Math.round((s.wins / traded) * 100)}% won) · no fill ${s.notFilled}`
      : `No trades closed yet${s.notFilled ? ` · no fill ${s.notFilled}` : ''}`,
    `Deepest drop from a high ${usd(s.maxDrawdown)} · skipped for lack of cash ${s.skipped}`,
    `Risk ${describeRisk(s)} — next trade ${usd(account.riskPerTrade())}, ${usd(account.free())} free`,
  ];
  const openIds = Object.keys(s.open);
  if (openIds.length) {
    lines.push('', `<b>Open</b> (${usd(account.committed())} at risk)`);
    for (const id of openIds) {
      const t = s.open[id];
      const d = live.find((x) => String(x._id) === id);
      const r = d && d.progress && d.progress.filled ? d.progress.currentR || 0 : null;
      lines.push(`• ${t.side} ${t.instrumentId} — ${usd(t.risk)} risk${r === null ? ', waiting for entry' : `, ${signedUsd(r * t.risk)} now`}`);
    }
  }
  if (!account.quote().take) lines.push('', '⚠️ Not enough free demo cash for the next trade — /deposit to continue.');
  lines.push('', '<i>Follows each plan exactly as sent; no spread or commission.</i>');
  return lines.join('\n');
}

/**
 * /whatif — replay already-resolved sent alerts on a hypothetical account.
 * Trades are taken in the order they closed, one at a time; a trade is
 * skipped when the balance cannot cover its risk.
 */
function simulateAccount(docs, { start, mode = 'fixed', value = config.risk.riskPerTrade }) {
  const ordered = [...docs].sort((a, b) => new Date(a.outcome.closedAt) - new Date(b.outcome.closedAt));
  let balance = start;
  let peak = start;
  let maxDrawdown = 0;
  let wins = 0;
  let losses = 0;
  let skipped = 0;
  let notFilled = 0;
  for (const d of ordered) {
    const risk = cents(mode === 'percent' ? (balance * value) / 100 : value);
    if (risk < 0.01 || balance + 1e-9 < risk) {
      skipped += 1;
      continue;
    }
    if (['expired', 'cancelled'].includes(d.outcome.status)) {
      notFilled += 1;
      continue;
    }
    const pnl = cents((d.outcome.rMultiple || 0) * risk);
    balance = cents(balance + pnl);
    if (pnl > 0) wins += 1;
    else if (pnl < 0) losses += 1;
    peak = Math.max(peak, balance);
    maxDrawdown = Math.max(maxDrawdown, cents(peak - balance));
  }
  return { start, end: balance, profit: cents(balance - start), wins, losses, skipped, notFilled, maxDrawdown, alerts: ordered.length };
}

function formatWhatIf(sim, { days, mode, value }) {
  if (!sim.alerts) return `No sent alerts have played out in the last ${days} day(s) — nothing to replay yet.`;
  const traded = sim.wins + sim.losses;
  return [
    `🧮 <b>What if: ${usd(sim.start)} over the last ${days} day(s)</b>`,
    `Risking ${mode === 'percent' ? `${value}% of the balance` : usd(value)} per trade on every alert sent`,
    `${usd(sim.start)} → <b>${usd(sim.end)}</b> (${signedUsd(sim.profit)}, ${signedPct(sim.profit / sim.start)})`,
    `Trades ${traded}: won ${sim.wins}, lost ${sim.losses} · no fill ${sim.notFilled}${sim.skipped ? ` · skipped for lack of cash ${sim.skipped}` : ''}`,
    `Deepest drop from a high ${usd(sim.maxDrawdown)}`,
    '',
    '<i>Uses the alerts that were actually sent and how they played out, taken one at a time in the order they closed. No spread or commission.</i>',
  ].join('\n');
}

function formatHistory(txns) {
  if (!txns.length) return 'No demo account activity yet.';
  const icon = { deposit: '➕', withdraw: '➖', result: '🔁', skip: '⏭', risk: '⚙️' };
  const lines = ['<b>Demo account history</b> (latest first)'];
  for (const t of txns) {
    const when = new Date(t.createdAt).toISOString().slice(5, 16).replace('T', ' ');
    const what =
      t.type === 'deposit'
        ? `deposit ${usd(t.amount)}`
        : t.type === 'withdraw'
          ? `withdraw ${usd(-t.amount)}`
          : t.type === 'result'
            ? `${t.instrumentId} ${signedUsd(t.amount)} — ${t.note}`
            : t.type === 'skip'
              ? `${t.instrumentId} skipped — ${t.note}`
              : `risk set to ${t.note}`;
    lines.push(`${icon[t.type] || '•'} ${when} ${what} → ${usd(t.balanceAfter)}`);
  }
  return lines.join('\n');
}

/** "2%" -> percent 2, "3" or "$3" -> fixed 3. */
function parseRisk(arg) {
  const m = /^\$?(\d+(?:\.\d+)?)(%)?$/.exec(String(arg || '').trim());
  if (!m) return null;
  return { mode: m[2] ? 'percent' : 'fixed', value: Number(m[1]) };
}

module.exports = {
  PaperAccount,
  quoteLine,
  resultLine,
  formatAccount,
  simulateAccount,
  formatWhatIf,
  formatHistory,
  parseRisk,
  describeRisk,
  PAPER_KEY: KEY,
};
