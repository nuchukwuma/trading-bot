'use strict';

const { createLogger } = require('../util/logger');

const log = createLogger('control:telegram');

const HELP = [
  '<b>SMC alert bot</b>',
  '',
  '/pairs — tap to turn alerts on or off per pair',
  '/on EURUSD — turn a pair on (several: /on EURUSD GBPUSD)',
  '/off VOL75 — turn a pair off',
  '/only EURUSD GBPUSD — alerts for these pairs and nothing else',
  '/all — every pair on',
  '/pause — stop all alerts · /resume — start again',
  '/trades — trades running or waiting for entry',
  '/results — how recent alerts played out (/results 30 for 30 days)',
  '/learning — what the bot has learned so far',
  '/status — last scan, next scan, what is on',
  '/scan — run a scan now',
  '',
  'Pairs that are off are still scanned and tracked, so learning keeps going — you just do not get the message.',
  '',
  'Every alert is followed until it plays out: you get a reply when the entry triggers, at each target, and when it wins, stops out or is invalidated — whether you took it or not.',
].join('\n');

const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Telegram command handler: lets the owner choose which pairs alert, pause
 * alerts, and check on the bot, from the same chat the alerts go to.
 *
 * Uses long polling (getUpdates), so it needs no public URL and works the
 * same locally and on Render. Only messages from the configured chat are
 * obeyed; anything else is ignored. Telegram allows ONE poller per bot token:
 * running the bot on your computer while Render runs it makes the two fight
 * (HTTP 409), so stop one of them.
 */
class TelegramControl {
  constructor({
    telegram,
    settings,
    getStatus = () => ({}),
    runScan = null,
    chatId,
    pollTimeoutSec = 50,
    reports = {},
  }) {
    // reports.trades() / reports.results(days) / reports.learning() -> text
    this.reports = reports;
    this.telegram = telegram;
    this.settings = settings;
    this.getStatus = getStatus;
    this.runScan = runScan;
    this.chatId = String(chatId);
    this.pollTimeoutSec = pollTimeoutSec;
    this.offset = 0;
    this.running = false;
    this.abort = null;
  }

  async start() {
    this.running = true;
    try {
      await this.telegram.call('setMyCommands', {
        commands: [
          { command: 'pairs', description: 'Choose which pairs send alerts' },
          { command: 'trades', description: 'Trades running or waiting for entry' },
          { command: 'results', description: 'How recent alerts played out' },
          { command: 'learning', description: 'What the bot has learned so far' },
          { command: 'status', description: 'Last scan, next scan, what is on' },
          { command: 'scan', description: 'Run a scan now' },
          { command: 'pause', description: 'Stop all alerts' },
          { command: 'resume', description: 'Start alerts again' },
          { command: 'help', description: 'All commands' },
        ],
      });
    } catch (err) {
      log.warn(`could not register the command menu: ${err.message}`);
    }
    log.info('listening for Telegram commands');
    this._loop();
    return this;
  }

  stop() {
    this.running = false;
    if (this.abort) this.abort.abort();
  }

  async _loop() {
    let backoff = 1000;
    let warnedConflict = false;
    while (this.running) {
      try {
        this.abort = new AbortController();
        const updates = await this.telegram.call(
          'getUpdates',
          { offset: this.offset, timeout: this.pollTimeoutSec, allowed_updates: ['message', 'callback_query'] },
          { signal: this.abort.signal }
        );
        backoff = 1000;
        warnedConflict = false;
        for (const update of updates) {
          this.offset = update.update_id + 1;
          await this.handleUpdate(update).catch((err) => log.error(`command failed: ${err.message}`));
        }
      } catch (err) {
        if (!this.running) return;
        if (err.status === 409) {
          if (!warnedConflict) {
            log.warn('another copy of the bot is reading Telegram commands (HTTP 409) — stop the other one');
            warnedConflict = true;
          }
          backoff = 30000;
        } else {
          log.warn(`command polling failed: ${err.message}`);
        }
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60000);
      }
    }
  }

  isOwner(chat) {
    return chat && String(chat.id) === this.chatId;
  }

  async handleUpdate(update) {
    if (update.callback_query) return this._onButton(update.callback_query);
    const msg = update.message;
    if (!msg || !msg.text) return null;
    if (!this.isOwner(msg.chat)) {
      log.warn(`ignored a command from chat ${msg.chat && msg.chat.id} — not TELEGRAM_CHAT_ID`);
      return null;
    }
    const [rawCmd, ...args] = msg.text.trim().split(/\s+/);
    const cmd = rawCmd.toLowerCase().replace(/@.*$/, '');
    const reply = (text, extra) => this.telegram.sendMessage(text, extra);

    switch (cmd) {
      case '/start':
      case '/help':
        return reply(HELP);
      case '/pairs':
        return reply(this._pairsText(), { replyMarkup: this._pairsKeyboard() });
      case '/status':
        return reply(this._statusText());
      case '/on':
      case '/off':
      case '/only':
        return reply(await this._setPairs(cmd, args));
      case '/all':
        await this.settings.setEnabled(this.settings.instruments.map((i) => i.id), true);
        return reply('✅ Alerts on for every pair.');
      case '/pause':
        await this.settings.setPaused(true);
        return reply('⏸ Alerts paused. Scanning and tracking carry on. /resume to start again.');
      case '/resume':
        await this.settings.setPaused(false);
        return reply(`▶️ Alerts resumed for ${this.settings.enabledIds().length} pair(s).`);
      case '/scan':
        return this._scanNow(reply);
      case '/trades':
      case '/open':
        return reply(await this._report('trades'));
      case '/results': {
        const days = Math.min(Math.max(parseInt(args[0], 10) || 7, 1), 365);
        return reply(await this._report('results', days));
      }
      case '/learning':
        return reply(await this._report('learning'));
      default:
        return reply('Unknown command. /help lists them.');
    }
  }

  async _report(name, ...args) {
    const fn = this.reports[name];
    if (!fn) return 'This needs MongoDB — the bot is running without a database.';
    return fn(...args);
  }

  async _setPairs(cmd, args) {
    if (!args.length) return `Name at least one pair, e.g. ${cmd} EURUSD`;
    const found = [];
    const unknown = [];
    for (const a of args) {
      const inst = this.settings.find(a);
      if (inst) found.push(inst.id);
      else unknown.push(a);
    }
    if (found.length) {
      if (cmd === '/only') {
        const all = this.settings.instruments.map((i) => i.id);
        await this.settings.setEnabled(all.filter((id) => !found.includes(id)), false);
        await this.settings.setEnabled(found, true);
      } else {
        await this.settings.setEnabled(found, cmd === '/on');
      }
    }
    const lines = [];
    if (found.length) {
      const verb = cmd === '/off' ? '🔕 Off' : '✅ On';
      lines.push(`${verb}: ${found.join(', ')}${cmd === '/only' ? ' (everything else off)' : ''}`);
    }
    if (unknown.length) {
      lines.push(`Not recognised: ${escape(unknown.join(', '))}`);
      lines.push(`Pairs: ${this.settings.instruments.map((i) => i.id).join(', ')}`);
    }
    return lines.join('\n');
  }

  async _scanNow(reply) {
    if (!this.runScan) return reply('Scanning on demand is not available here.');
    await reply('🔎 Scanning…');
    const results = await this.runScan();
    if (!results) return reply('A scan is already running — try again in a moment.');
    const fired = results.filter((r) => r.fired).length;
    const muted = results.filter((r) => r.stage === 'muted').length;
    const errors = results.filter((r) => r.stage === 'error');
    const lines = [`Scan done: ${fired} alert(s) sent from ${results.length} pair(s).`];
    if (muted) lines.push(`${muted} setup(s) on pairs that are off were tracked, not sent.`);
    if (errors.length) lines.push(`Failed: ${errors.map((e) => escape(`${e.instrumentId} (${e.reason})`)).join(', ')}`);
    return reply(lines.join('\n'));
  }

  async _onButton(q) {
    if (!this.isOwner(q.message && q.message.chat)) {
      return this.telegram.call('answerCallbackQuery', { callback_query_id: q.id });
    }
    const data = q.data || '';
    let note = '';
    if (data.startsWith('t:')) {
      const on = await this.settings.toggle(data.slice(2));
      note = `${data.slice(2)} ${on ? 'on' : 'off'}`;
    } else if (data === 'all:on' || data === 'all:off') {
      await this.settings.setEnabled(this.settings.instruments.map((i) => i.id), data === 'all:on');
      note = data === 'all:on' ? 'All on' : 'All off';
    }
    await this.telegram.call('answerCallbackQuery', { callback_query_id: q.id, text: note });
    await this.telegram
      .call('editMessageText', {
        chat_id: q.message.chat.id,
        message_id: q.message.message_id,
        text: this._pairsText(),
        parse_mode: 'HTML',
        reply_markup: this._pairsKeyboard(),
      })
      .catch((err) => {
        // "message is not modified" is harmless — the state did not change.
        if (!/not modified/.test(err.message)) throw err;
      });
    return null;
  }

  _pairsText() {
    const on = this.settings.enabledIds().length;
    const total = this.settings.instruments.length;
    const lines = [`<b>Alert pairs</b> — ${on} of ${total} on. Tap to switch.`];
    if (this.settings.paused) lines.push('⏸ <b>All alerts are paused</b> — /resume to start again.');
    return lines.join('\n');
  }

  _pairsKeyboard() {
    const buttons = this.settings.instruments.map((i) => ({
      text: `${this.settings.isEnabled(i.id) ? '✅' : '⬜️'} ${i.id}`,
      callback_data: `t:${i.id}`,
    }));
    const rows = [];
    for (let i = 0; i < buttons.length; i += 3) rows.push(buttons.slice(i, i + 3));
    rows.push([
      { text: 'All on', callback_data: 'all:on' },
      { text: 'All off', callback_data: 'all:off' },
    ]);
    return { inline_keyboard: rows };
  }

  _statusText() {
    const s = this.getStatus();
    const fmt = (iso) => (iso ? iso.replace('T', ' ').slice(0, 16) + ' UTC' : '—');
    const on = this.settings.enabledIds();
    const off = this.settings.instruments.map((i) => i.id).filter((id) => !this.settings.isEnabled(id));
    return [
      '<b>Status</b>',
      this.settings.paused ? '⏸ Alerts paused' : '▶️ Alerts on',
      `Last scan: ${fmt(s.lastScanAt)}${s.scans ? ` (${s.scans} since start)` : ''}`,
      `Next scan: ${fmt(s.nextScanAt)}`,
      `On (${on.length}): ${on.join(', ') || 'none'}`,
      off.length ? `Off (${off.length}): ${off.join(', ')}` : null,
      `Database: ${s.database ? 'connected' : 'not connected — choices reset on restart'}`,
    ]
      .filter(Boolean)
      .join('\n');
  }
}

module.exports = { TelegramControl, HELP };
