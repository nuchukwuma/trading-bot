'use strict';

const { createLogger } = require('../util/logger');

const log = createLogger('control:settings');

const KEY = 'alertSettings';

/**
 * Which instruments send alerts, and whether alerts are paused altogether.
 *
 * Changed from Telegram and kept in MongoDB so a restart (or a Render
 * spin-down) does not undo the user's choices. Without a database it still
 * works, but only until the process restarts.
 *
 * Muting only stops the MESSAGE. A muted instrument is still scanned and its
 * setups are still tracked and learned from, the same way the edge profile's
 * held-back setups are — turning a pair back on does not start from nothing.
 */
class AlertSettings {
  constructor({ instruments, db = null } = {}) {
    this.instruments = instruments;
    this.db = db;
    this.muted = new Set();
    this.paused = false;
  }

  async load() {
    if (!this.db) return this;
    try {
      const saved = await this.db.getSetting(KEY);
      if (saved) {
        const known = new Set(this.instruments.map((i) => i.id));
        this.muted = new Set((saved.muted || []).filter((id) => known.has(id)));
        this.paused = Boolean(saved.paused);
      }
    } catch (err) {
      log.warn(`could not load alert settings: ${err.message}`);
    }
    return this;
  }

  async save() {
    if (!this.db) return;
    try {
      await this.db.setSetting(KEY, { muted: [...this.muted], paused: this.paused });
    } catch (err) {
      log.warn(`could not save alert settings: ${err.message}`);
    }
  }

  /** Resolve "eurusd", "EUR/USD" or "vol75" to an instrument, or null. */
  find(name) {
    const want = String(name || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
    return this.instruments.find((i) => i.id === want || i.displayName.replace(/[^a-z0-9]/gi, '').toUpperCase() === want) || null;
  }

  isEnabled(id) {
    return !this.muted.has(id);
  }

  /** Whether an alert for this instrument should actually be sent. */
  shouldAlert(id) {
    return !this.paused && this.isEnabled(id);
  }

  async setEnabled(ids, enabled) {
    for (const id of [].concat(ids)) {
      if (enabled) this.muted.delete(id);
      else this.muted.add(id);
    }
    await this.save();
  }

  async toggle(id) {
    await this.setEnabled(id, !this.isEnabled(id));
    return this.isEnabled(id);
  }

  async setPaused(paused) {
    this.paused = Boolean(paused);
    await this.save();
  }

  enabledIds() {
    return this.instruments.map((i) => i.id).filter((id) => this.isEnabled(id));
  }
}

module.exports = { AlertSettings };
