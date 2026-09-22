'use strict';

const config = require('../config');
const { createLogger } = require('../util/logger');

const log = createLogger('alerts:telegram');
const MAX_MESSAGE_LENGTH = 4096;

/**
 * Minimal Telegram Bot API client — only sendMessage is used, so the bot can
 * run on a token with no other permissions.
 */
class TelegramClient {
  constructor(opts = {}) {
    this.cfg = { ...config.alerts.telegram, ...opts };
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.retries = Number.isFinite(opts.retries) ? opts.retries : 3;
    this.retryDelayMs = Number.isFinite(opts.retryDelayMs) ? opts.retryDelayMs : 1000;
    this.sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get configured() {
    return Boolean(this.cfg.botToken && this.cfg.chatId);
  }

  async sendMessage(text, opts = {}) {
    if (!this.configured) {
      throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must both be set');
    }

    const chunks = splitMessage(text);
    const results = [];
    for (const chunk of chunks) {
      results.push(await this._sendOne(chunk, opts));
    }
    return results;
  }

  async _sendOne(text, opts) {
    const url = `${this.cfg.apiUrl}/bot${this.cfg.botToken}/sendMessage`;
    const payload = {
      chat_id: opts.chatId || this.cfg.chatId,
      text,
      parse_mode: opts.parseMode || this.cfg.parseMode,
      disable_web_page_preview: true,
    };

    let lastError = null;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      if (attempt > 0) await this.sleep(this.retryDelayMs * 2 ** (attempt - 1));
      try {
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const json = await res.json().catch(() => ({}));

        if (res.ok && json.ok) return json.result;

        // 4xx other than rate limiting will not succeed on a retry.
        const retryable = res.status === 429 || res.status >= 500;
        lastError = new Error(`Telegram ${res.status}: ${json.description || res.statusText || 'send failed'}`);
        if (!retryable) throw lastError;
        log.warn(`send failed (attempt ${attempt + 1}/${this.retries + 1}): ${lastError.message}`);
      } catch (err) {
        lastError = err;
        if (err.message && err.message.startsWith('Telegram 4') && !err.message.startsWith('Telegram 429')) throw err;
        log.warn(`send error (attempt ${attempt + 1}/${this.retries + 1}): ${err.message}`);
      }
    }
    throw lastError || new Error('Telegram send failed');
  }
}

/** Telegram caps a message at 4096 characters; split on line boundaries. */
function splitMessage(text, limit = MAX_MESSAGE_LENGTH) {
  if (text.length <= limit) return [text];
  const out = [];
  let current = '';
  const flush = () => {
    if (current) out.push(current);
    current = '';
  };

  for (const line of text.split('\n')) {
    // A single line longer than the limit has no boundary to break on, so it
    // is hard-chunked rather than truncated — nothing is ever dropped.
    if (line.length > limit) {
      flush();
      for (let i = 0; i < line.length; i += limit) out.push(line.slice(i, i + limit));
      continue;
    }
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit) {
      flush();
      current = line;
    } else {
      current = candidate;
    }
  }

  flush();
  return out;
}

module.exports = { TelegramClient, splitMessage, MAX_MESSAGE_LENGTH };
