'use strict';

/**
 * Diagnose a Deriv connection that fails at the handshake (e.g. HTTP 520).
 * Tries each endpoint, with and without an Origin header, and prints what the
 * server answers. Run: node scripts/probe-deriv.js
 */

require('dotenv').config();
const WebSocket = require('ws');

const appId = process.env.DERIV_APP_ID || '1089';
const hosts = ['wss://ws.derivws.com/websockets/v3', 'wss://ws.binaryws.com/websockets/v3'];
const origins = [null, 'https://api.deriv.com'];

function probe(url, origin) {
  return new Promise((resolve) => {
    const opts = { handshakeTimeout: 15000 };
    if (origin) opts.origin = origin;
    const ws = new WebSocket(`${url}?app_id=${appId}`, opts);
    const done = (result) => {
      ws.removeAllListeners();
      ws.on('error', () => {});
      ws.terminate();
      resolve(result);
    };
    ws.on('unexpected-response', (req, res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => done(`HTTP ${res.statusCode} ${res.headers.server || ''} ${body.replace(/\s+/g, ' ').slice(0, 120)}`));
    });
    ws.on('open', () => ws.send(JSON.stringify({ ping: 1 })));
    ws.on('message', (m) => done(`OK — ${String(m).slice(0, 80)}`));
    ws.on('error', (err) => done(`error: ${err.message}`));
  });
}

(async () => {
  console.log(`app_id ${appId}`);
  for (const url of hosts) {
    for (const origin of origins) {
      console.log(`${url}  origin=${origin || 'none'}\n  -> ${await probe(url, origin)}`);
    }
  }
})();
