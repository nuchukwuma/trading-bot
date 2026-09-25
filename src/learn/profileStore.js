'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { EdgeProfile, PROFILE_VERSION } = require('../backtest/edgeProfile');
const { createLogger } = require('../util/logger');

const log = createLogger('learn:profile');

const KEY = 'edgeProfile';
const profileOpts = () => ({ required: config.edge.required, enforceUnvalidated: config.edge.enforceUnvalidated });

/**
 * Where the learned profile lives. MongoDB first, so a restart on a host with
 * a wiped disk (Render) comes back with everything it had learned; the JSON
 * file is a fallback for running without a database and a copy for reading.
 */
async function loadProfile({ db = null, filePath = config.edge.profilePath } = {}) {
  if (db && db.isConnected && db.isConnected()) {
    try {
      const data = await db.getSetting(KEY);
      if (data && data.version === PROFILE_VERSION) return new EdgeProfile(data, profileOpts());
    } catch (err) {
      log.warn(`could not read the profile from MongoDB: ${err.message}`);
    }
  }
  return EdgeProfile.load(filePath, profileOpts());
}

async function saveProfile({ db = null, filePath = config.edge.profilePath, result }) {
  const payload = EdgeProfile.build(result);
  if (db && db.isConnected && db.isConnected()) {
    try {
      await db.setSetting(KEY, payload);
    } catch (err) {
      log.error(`could not save the profile to MongoDB: ${err.message}`);
    }
  }
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
  } catch (err) {
    log.debug(`profile file not written: ${err.message}`);
  }
  return new EdgeProfile(payload, profileOpts());
}

module.exports = { loadProfile, saveProfile, PROFILE_KEY: KEY };
