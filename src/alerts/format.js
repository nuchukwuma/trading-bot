'use strict';

const config = require('../config');
const { formatPrice, formatDistance, formatMoney, formatLots } = require('../util/format');
const { formatUtc } = require('../util/time');
const { describeRating } = require('../learn/rater');

const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Render a fired setup as a Telegram HTML message.
 *
 * Every confirmation that fired is listed with its one-line reason, so the
 * alert explains itself without anyone needing to open a chart.
 */
function formatAlert(alert) {
  const { instrument, direction, plan, bias, score, required, total, confirmations, candleTime } = alert;
  const price = (n) => formatPrice(n, instrument);
  const bullish = direction === 'bullish';
  const arrow = bullish ? '🟢' : '🔴';
  const lines = [];

  lines.push(
    `${arrow} <b>${escapeHtml(plan.side)} ${escapeHtml(instrument.id)}</b> — ${escapeHtml(instrument.displayName)}`
  );
  lines.push(
    `<i>${score}/${total} confirmations · 4H bias ${escapeHtml(bias.direction.toUpperCase())} (${escapeHtml(
      bias.strength
    )})</i>`
  );
  const rating = describeRating(alert.rating);
  if (rating.length) {
    lines.push('');
    lines.push(...rating);
  }
  lines.push('');

  lines.push('<b>Trade plan</b>');
  lines.push(`<code>Entry  ${price(plan.entryPrice)}</code>`);
  lines.push(`<code>Stop   ${price(plan.stopPrice)}  (${formatDistance(plan.riskDistance, instrument)})</code>`);
  for (const t of plan.targets) {
    const note = t.moveStopToBreakeven
      ? ' → SL to breakeven'
      : t.trailToStructure
        ? ' → trail behind structure'
        : t.remainingPct === 0
          ? ' → close out'
          : '';
    lines.push(
      `<code>${t.name}    ${price(t.price)}  1:${t.rr.toFixed(2)}  close ${t.closePct}%</code>${escapeHtml(note)}`
    );
  }
  if (plan.targets.some((t) => t.cappedBy)) {
    const capped = plan.targets.filter((t) => t.cappedBy);
    lines.push(
      `<i>${capped.map((t) => t.name).join('/')} pulled back to ${escapeHtml(
        capped[0].cappedBy.kind
      )} liquidity at ${price(capped[0].cappedBy.price)}</i>`
    );
  }
  lines.push('');

  lines.push('<b>Risk</b>');
  lines.push(
    `<code>${formatLots(plan.position.lots)} lots · risk ${formatMoney(plan.position.actualRiskUsd)} of ${formatMoney(
      config.risk.accountBalance
    )}</code>`
  );
  lines.push(`<code>R:R to TP1 1:${plan.riskReward.toFixed(2)}</code>`);
  lines.push('');

  lines.push(`<b>Confirmations (${score}/${total}, ${required} required)</b>`);
  for (const c of confirmations) {
    lines.push(`✅ ${escapeHtml(c.reason)}`);
  }

  const notFired = (alert.allConfirmations || []).filter((c) => !c.passed);
  if (notFired.length) {
    lines.push('');
    lines.push('<b>Did not fire</b>');
    for (const c of notFired) lines.push(`▫️ ${escapeHtml(c.reason)}`);
  }

  if (bias.reasons && bias.reasons.length) {
    lines.push('');
    lines.push('<b>HTF read</b>');
    for (const r of bias.reasons) lines.push(`• ${escapeHtml(r)}`);
  }

  const warnings = plan.warnings || [];
  if (warnings.length) {
    lines.push('');
    lines.push('<b>⚠️ Warnings</b>');
    for (const w of warnings) lines.push(`• ${escapeHtml(w)}`);
  }

  if (alert.edgeProfile && alert.edgeProfile.active) {
    lines.push('');
    lines.push(`<i>✔ ${escapeHtml(alert.edgeProfile.reason)}</i>`);
  }

  lines.push('');
  lines.push(`<i>30m candle close ${escapeHtml(formatUtc(candleTime))}</i>`);
  lines.push('<i>Analysis only — this bot places no orders.</i>');

  return lines.join('\n');
}

/** One-line version for logs and console output. */
function formatAlertLine(alert) {
  const { instrument, plan, score, total } = alert;
  return `${plan.side} ${instrument.id} @ ${formatPrice(plan.entryPrice, instrument)} SL ${formatPrice(
    plan.stopPrice,
    instrument
  )} TP1 ${formatPrice(plan.targets[0].price, instrument)} | ${score}/${total} | ${formatLots(plan.position.lots)} lots`;
}

module.exports = { formatAlert, formatAlertLine, escapeHtml };
