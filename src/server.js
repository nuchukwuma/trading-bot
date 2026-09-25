'use strict';

const http = require('http');
const { createLogger } = require('./util/logger');

const log = createLogger('server');

/**
 * A minimal HTTP face for hosts that only run web services (Render's free
 * tier). It serves a status page and a health check, and optionally pings its
 * own public URL so the host does not idle it to sleep.
 *
 * Render spins a free web service down after 15 minutes without INBOUND
 * requests. A request the app sends to its own public URL goes out through
 * Render's proxy and back in, so it counts. Once asleep, the app cannot wake
 * itself — an external pinger has to do that (see the README).
 */

/**
 * Parse a keep-awake window such as "6-22" (06:00 up to 22:00) or "22-6"
 * (overnight). Empty, "always" or "0-24" means all day. Returns null for
 * all day, else { start, end } in whole hours.
 */
function parseHours(spec) {
  const s = String(spec || '').trim().toLowerCase();
  if (!s || s === 'always' || s === 'all') return null;
  const m = s.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (!m) throw new Error(`KEEP_AWAKE_HOURS must look like "6-22", got "${spec}"`);
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (start > 23 || end > 24) throw new Error(`KEEP_AWAKE_HOURS out of range: "${spec}"`);
  if ((start === 0 && end === 24) || start === end) return null;
  return { start, end };
}

/** Hour of day (0-23) at `date` in the IANA time zone `tz`. */
function hourIn(date, tz) {
  const h = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: tz }).format(date);
  return Number(h);
}

/** Whether `date` falls inside the window (null window = always). */
function inWindow(date, window, tz = 'UTC') {
  if (!window) return true;
  const h = hourIn(date, tz);
  return window.start < window.end ? h >= window.start && h < window.end : h >= window.start || h < window.end;
}

/**
 * Serve GET / (status JSON) and GET /healthz. `getStatus` is called per
 * request so the page always reflects the scheduler's latest state.
 */
function startServer({ port, getStatus = () => ({}) }) {
  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    if (url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      return;
    }
    if (url === '/') {
      const body = JSON.stringify({ ok: true, uptimeSeconds: Math.round(process.uptime()), ...getStatus() });
      res.writeHead(200, { 'content-type': 'application/json' }).end(body);
      return;
    }
    res.writeHead(404).end();
  });
  // A port clash is logged rather than thrown: the bot's real job is
  // scanning, and an unhandled server error would otherwise take it down.
  server.on('error', (err) => log.error(`HTTP server failed on port ${port}: ${err.message}`));
  server.listen(port, () => log.info(`listening on port ${server.address().port}`));
  return server;
}

/**
 * Ping `url` every `intervalMs` while inside the window. Outside it the pings
 * stop and the host is free to put the service to sleep.
 */
function startKeepAwake({ url, intervalMs, window, tz, fetchFn = globalThis.fetch, now = () => new Date() }) {
  const target = `${url.replace(/\/+$/, '')}/healthz`;
  const tick = async () => {
    if (!inWindow(now(), window, tz)) {
      log.debug('outside keep-awake hours — not pinging');
      return;
    }
    try {
      const res = await fetchFn(target, { signal: AbortSignal.timeout(15000) });
      log.debug(`keep-awake ping ${res.status}`);
    } catch (err) {
      log.warn(`keep-awake ping failed: ${err.message}`);
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  const hours = window ? `${window.start}:00-${window.end}:00 ${tz}` : 'all day';
  log.info(`keep-awake: pinging ${target} every ${Math.round(intervalMs / 60000)} min, ${hours}`);
  return { stop: () => clearInterval(timer), tick };
}

module.exports = { parseHours, hourIn, inWindow, startServer, startKeepAwake };
