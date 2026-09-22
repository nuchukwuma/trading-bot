'use strict';

const { detectPatterns } = require('./patterns');
const { detectPriceActionFeatures } = require('./priceAction');
const { extractContext } = require('./context');

/**
 * The feature vector attached to every setup, as a flat list of string tokens
 * such as `pattern:double_bottom`, `session:london`, `vol:high`.
 *
 * Tokens are what the learner searches over. Adding a new one here is all it
 * takes to put a new hypothesis in front of the learner — it will be measured
 * against outcomes like every other, and ignored unless it earns its place.
 */
function extractFeatures({ instrument, bias, scoring, plan, ltfCandles, htfCandles, opts = {} }) {
  const tokens = [];

  for (const p of detectPatterns(ltfCandles, opts.patterns)) tokens.push(`pattern:${p}`);
  if (htfCandles && htfCandles.length) {
    for (const p of detectPatterns(htfCandles, opts.patterns)) tokens.push(`htf_pattern:${p}`);
  }

  // Structural price action: break and retest, breakers, inducement.
  for (const f of detectPriceActionFeatures({
    candles: ltfCandles,
    structure: scoring.ltfStructure,
    pois: scoring.ltfPois || [],
    direction: bias.direction,
    entryPoi: scoring.entryPoi,
    price: scoring.price,
    opts: opts.priceAction,
  })) {
    tokens.push(`pa:${f}`);
  }

  tokens.push(...extractContext({ instrument, bias, scoring, plan, ltfCandles }));

  // Stable order, no duplicates — signatures have to be comparable.
  return [...new Set(tokens)].sort();
}

module.exports = { extractFeatures, detectPatterns, detectPriceActionFeatures, extractContext };
