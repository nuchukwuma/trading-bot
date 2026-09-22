'use strict';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Round to a multiple of `step`, defaulting to floor (never over-risk). */
function roundToStep(value, step, mode = 'floor') {
  if (!step || step <= 0) return value;
  // Binary float dust would make 0.05 / 0.01 come out as 4.999999999999999 and
  // floor to the wrong step, so normalise the quotient before rounding it.
  const n = Number((value / step).toFixed(9));
  const rounded = mode === 'ceil' ? Math.ceil(n) : mode === 'round' ? Math.round(n) : Math.floor(n);
  // Re-round to kill binary float dust (0.06999999999 -> 0.07).
  const decimals = decimalsOf(step);
  return Number((rounded * step).toFixed(decimals));
}

function decimalsOf(step) {
  const s = String(step);
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

/** Fixed-precision rounding that avoids `-0` and float dust. */
function round(value, precision = 5) {
  const f = Number(value.toFixed(precision));
  return Object.is(f, -0) ? 0 : f;
}

/** Are two prices equal within `tolerance` (absolute price units)? */
function withinTolerance(a, b, tolerance) {
  return Math.abs(a - b) <= tolerance;
}

/** Overlap length of [aLow,aHigh] and [bLow,bHigh]; 0 when they do not touch. */
function overlap(aLow, aHigh, bLow, bHigh) {
  return Math.max(0, Math.min(aHigh, bHigh) - Math.max(aLow, bLow));
}

function overlaps(aLow, aHigh, bLow, bHigh) {
  return Math.min(aHigh, bHigh) >= Math.max(aLow, bLow);
}

module.exports = { clamp, roundToStep, decimalsOf, round, withinTolerance, overlap, overlaps };
