'use strict';

const SECOND = 1000;

/** Epoch seconds for the OPEN of the timeframe bucket containing `epochSec`. */
function bucketStart(epochSec, tfSeconds) {
  return Math.floor(epochSec / tfSeconds) * tfSeconds;
}

/** Epoch seconds of the next timeframe boundary strictly after `epochSec`. */
function nextBoundary(epochSec, tfSeconds) {
  return bucketStart(epochSec, tfSeconds) + tfSeconds;
}

/** Milliseconds to wait until the next boundary (+ a settle delay). */
function msUntilNextBoundary(tfSeconds, delaySeconds = 0, now = Date.now()) {
  const nowSec = now / SECOND;
  const target = nextBoundary(Math.floor(nowSec), tfSeconds) + delaySeconds;
  return Math.max(0, Math.round(target * SECOND - now));
}

function toIso(epochSec) {
  return new Date(epochSec * SECOND).toISOString();
}

/** '2026-09-22 14:30 UTC' — compact, unambiguous, for alert bodies. */
function formatUtc(epochSec) {
  const d = new Date(epochSec * SECOND);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(
    d.getUTCHours()
  )}:${pad(d.getUTCMinutes())} UTC`;
}

module.exports = { bucketStart, nextBoundary, msUntilNextBoundary, toIso, formatUtc, SECOND };
