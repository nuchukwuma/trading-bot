'use strict';

const config = require('../config');
const { formatPrice } = require('../util/format');
const { formatUtc } = require('../util/time');
const { GRADES } = require('../learn/rater');
const { escapeHtml } = require('./format');

/**
 * Telegram messages for how a sent alert is playing out, and the /trades and
 * /results summaries. Every figure assumes the plan was followed exactly as
 * sent — it is the bot's own scorecard, whether or not anyone took the trade.
 */

const instrumentOf = (doc) =>
  config.instrumentById(doc.instrumentId) || { id: doc.instrumentId, displayName: doc.instrumentId, pricePrecision: 5 };

const signedR = (r) => `${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(2)}R`;

function money(doc, r) {
  const risk = doc.tradePlan && doc.tradePlan.riskUsd;
  if (!Number.isFinite(risk) || !Number.isFinite(r)) return '';
  const v = r * risk;
  return ` (${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)})`;
}

const title = (doc) => `${escapeHtml(doc.side)} ${escapeHtml(doc.instrumentId)}`;

function formatTradeEvent(doc, event) {
  const inst = instrumentOf(doc);
  const price = (n) => formatPrice(n, inst);
  const plan = doc.tradePlan || {};

  if (event.type === 'filled') {
    return [
      `▶️ <b>Entry triggered</b> — ${title(doc)} @ ${price(plan.entryPrice)}`,
      `Stop ${price(plan.stopPrice)} · TP1 ${price(plan.targets[0].price)}`,
    ].join('\n');
  }

  if (event.type === 'target') {
    const t = (plan.targets || []).find((x) => x.name === event.name) || {};
    const next = t.moveStopToBreakeven
      ? 'Move the stop to breakeven.'
      : t.trailToStructure
        ? 'Trail the stop behind 30m structure.'
        : '';
    return [
      `🎯 <b>${escapeHtml(event.name)} hit</b> — ${title(doc)} @ ${price(t.price)}`,
      `Close ${t.closePct}% here. ${next}`.trim(),
      `Running ${signedR(event.progress.currentR)}${money(doc, event.progress.currentR)} marked at the last close.`,
    ].join('\n');
  }

  // closed
  const o = event.outcome;
  const reached = (o.exits || []).map((e) => e.reason).filter((r) => /^TP\d$/.test(r));
  switch (o.status) {
    case 'expired':
      return [
        `⚪️ <b>Invalidated</b> — ${title(doc)}`,
        `Price never came back to the entry at ${price(plan.entryPrice)} within 4 hours (8 candles). No trade — cancel the order if you placed one.`,
      ].join('\n');
    case 'stopped':
      return [
        `❌ <b>Stopped out</b> — ${title(doc)} at ${price(plan.stopPrice)}`,
        `Result ${signedR(o.rMultiple)}${money(doc, o.rMultiple)}.`,
      ].join('\n');
    case 'timeout':
      return [
        `⏱ <b>Closed at the end of the 48h window</b> — ${title(doc)}`,
        reached.length ? `Reached ${reached.join(', ')}.` : '',
        `Remainder marked at the last close: ${signedR(o.rMultiple)}${money(doc, o.rMultiple)} overall.`,
      ]
        .filter(Boolean)
        .join('\n');
    default: {
      const top = o.status.toUpperCase();
      const allOut = top === 'TP3';
      return [
        `✅ <b>Win</b> — ${title(doc)} reached ${top}`,
        allOut ? 'Every target paid.' : `${reached.join(', ')} paid, the rest closed on the moved stop.`,
        `Result ${signedR(o.rMultiple)}${money(doc, o.rMultiple)}.`,
      ].join('\n');
    }
  }
}

/** /trades — every sent alert that has not played out. */
function formatOpenTrades(docs, { shadowCount = 0, nextScanAt = null } = {}) {
  if (!docs.length) {
    const lines = ['📭 <b>No open trades.</b> Nothing is waiting for entry or running.'];
    if (shadowCount) lines.push(`<i>${shadowCount} setup(s) on pairs that are off or held back are being tracked for learning.</i>`);
    if (nextScanAt) lines.push(`Next scan: ${formatUtc(Math.floor(new Date(nextScanAt).getTime() / 1000))}`);
    return lines.join('\n');
  }
  const waiting = docs.filter((d) => !(d.progress && d.progress.filled));
  const running = docs.filter((d) => d.progress && d.progress.filled);
  const lines = [`<b>Open trades</b> — ${running.length} running, ${waiting.length} waiting for entry`];

  for (const d of running) {
    const inst = instrumentOf(d);
    const p = d.progress;
    const hit = p.targetsHit && p.targetsHit.length ? ` · ${p.targetsHit.join(', ')} paid` : '';
    lines.push('');
    lines.push(`▶️ <b>${title(d)}</b> ${gradeIcon(d)}`);
    lines.push(
      `Entry ${formatPrice(d.tradePlan.entryPrice, inst)} · now ${formatPrice(p.lastPrice, inst)} · ` +
        `${signedR(p.currentR || 0)}${money(d, p.currentR || 0)}${hit}`
    );
  }
  for (const d of waiting) {
    const inst = instrumentOf(d);
    const bars = (d.progress && d.progress.barsSinceSignal) || 0;
    lines.push('');
    lines.push(`⏳ <b>${title(d)}</b> ${gradeIcon(d)}`);
    lines.push(
      `Limit at ${formatPrice(d.tradePlan.entryPrice, inst)}` +
        (d.progress && Number.isFinite(d.progress.lastPrice) ? ` · now ${formatPrice(d.progress.lastPrice, inst)}` : '') +
        ` · ${Math.max(0, 8 - bars)} candle(s) left to fill`
    );
  }
  if (shadowCount) {
    lines.push('');
    lines.push(`<i>+${shadowCount} setup(s) on pairs that are off or held back, tracked for learning.</i>`);
  }
  return lines.join('\n');
}

/** /results — recent played-out alerts and the running total. */
function formatResults(docs, { days }) {
  if (!docs.length) return `No sent alerts have played out in the last ${days} day(s).`;
  const traded = docs.filter((d) => d.outcome.status !== 'expired');
  const wins = traded.filter((d) => d.outcome.rMultiple > 0).length;
  const totalR = traded.reduce((a, d) => a + (d.outcome.rMultiple || 0), 0);
  const usd = traded.reduce((a, d) => a + (d.outcome.rMultiple || 0) * (d.tradePlan.riskUsd || 0), 0);
  const icon = { stopped: '❌', expired: '⚪️', timeout: '⏱' };
  const lines = [
    `<b>Last ${days} day(s)</b> — ${traded.length} traded, ${docs.length - traded.length} invalidated`,
    traded.length
      ? `Won ${wins}/${traded.length} (${Math.round((wins / traded.length) * 100)}%) · total ${signedR(totalR)} (${usd >= 0 ? '+' : '−'}$${Math.abs(usd).toFixed(2)})`
      : '',
    '',
  ];
  for (const d of docs.slice(0, 15)) {
    const s = d.outcome.status;
    const r = s === 'expired' ? 'no fill' : signedR(d.outcome.rMultiple || 0);
    lines.push(`${icon[s] || '✅'} ${title(d)} — ${s.toUpperCase()} ${r} ${gradeIcon(d)}`);
  }
  return lines.filter((l, i) => l !== '' || i > 0).join('\n');
}

function gradeIcon(doc) {
  const g = doc.rating && GRADES[doc.rating.grade];
  return g ? g.icon : '';
}

module.exports = { formatTradeEvent, formatOpenTrades, formatResults };
