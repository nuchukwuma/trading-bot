'use strict';

const fs = require('fs');
const path = require('path');
const { matchesRules, hasFeature } = require('./analyze');
const { adjustmentFor } = require('../learn/planLearner');
const { createLogger } = require('../util/logger');

const log = createLogger('edge-profile');

const PROFILE_VERSION = 1;

/**
 * The learned pre-alert filter.
 *
 * `npm run backtest` writes one of these; the scanner loads it and every setup
 * that clears the R:R gate must also match its rules before an alert is sent.
 * That is the difference between "everything that looked good" and "the subset
 * that historically paid".
 *
 * A profile is only enforced when it was validated out-of-sample. One that
 * failed its holdout check is loaded but NOT enforced — acting on rules that
 * only worked on the data they were fitted to is worse than not filtering.
 */
class EdgeProfile {
  constructor(data = null, opts = {}) {
    this.data = data;
    this.enforceUnvalidated = Boolean(opts.enforceUnvalidated);
    this.required = Boolean(opts.required);
  }

  static load(filePath, opts = {}) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(raw);
      if (data.version !== PROFILE_VERSION) {
        log.warn(`profile at ${filePath} is version ${data.version}, expected ${PROFILE_VERSION} — ignoring it`);
        return new EdgeProfile(null, opts);
      }
      return new EdgeProfile(data, opts);
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn(`could not read ${filePath}: ${err.message}`);
      return new EdgeProfile(null, opts);
    }
  }

  /** The stored shape of a learner result. */
  static build({ rules, validated, notes, train, test, unfilteredTest, plan = null, meta = {} }) {
    return {
      version: PROFILE_VERSION,
      generatedAt: new Date().toISOString(),
      validated,
      rules,
      // Learned stop/target placement per market group (planLearner.js).
      // Each entry was validated on its own, so it applies even when the
      // setup filter above has not been validated yet.
      plan,
      notes,
      performance: { train, test, unfilteredTest },
      meta,
    };
  }

  static save(filePath, result) {
    const payload = EdgeProfile.build(result);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
    return payload;
  }

  get loaded() {
    return this.data !== null;
  }

  get validated() {
    return Boolean(this.data && this.data.validated);
  }

  /** Is this profile actually filtering anything right now? */
  get active() {
    if (!this.loaded) return false;
    return this.validated || this.enforceUnvalidated;
  }

  /** The learned stop/target placement for an instrument, or null for the default. */
  planFor(instrumentId) {
    return adjustmentFor(this.data && this.data.plan, instrumentId);
  }

  get rules() {
    return (this.data && this.data.rules) || null;
  }

  /**
   * @returns {{ allow: boolean, reason: string }}
   */
  evaluate(setup) {
    if (!this.loaded) {
      return this.required
        ? { allow: false, reason: 'No edge profile found and EDGE_PROFILE_REQUIRED is set — run npm run backtest' }
        : { allow: true, reason: 'No edge profile — alerting every setup that clears the gates' };
    }
    if (!this.active) {
      return this.required
        ? { allow: false, reason: 'Edge profile failed its out-of-sample check and EDGE_PROFILE_REQUIRED is set' }
        : { allow: true, reason: 'Edge profile failed out-of-sample validation — not enforced' };
    }

    const candidate = {
      score: setup.score,
      confirmations: setup.confirmations,
      biasStrength: setup.biasStrength,
      direction: setup.direction,
      instrumentId: setup.instrumentId,
      // Learned chart-pattern/context rules match on these. Dropping them made
      // a required-feature rule block every live setup and an excluded one
      // never apply.
      features: setup.features || [],
    };

    if (matchesRules(candidate, this.rules)) {
      return { allow: true, reason: this.describeMatch(candidate) };
    }
    return { allow: false, reason: this.describeMiss(candidate) };
  }

  describeMatch(setup) {
    const parts = [`score ${setup.score} >= ${this.rules.minScore}`];
    if (this.rules.requiredConfirmations.length) {
      parts.push(`has ${this.rules.requiredConfirmations.join(' + ')}`);
    }
    if (this.rules.minBiasStrength) parts.push(`${setup.biasStrength} bias`);
    if ((this.rules.requiredFeatures || []).length) parts.push(`shows ${this.rules.requiredFeatures.join(' + ')}`);
    return `Matches the backtested profile (${parts.join(', ')})`;
  }

  describeMiss(setup) {
    const r = this.rules;
    if (r.minScore && setup.score < r.minScore) {
      return `Score ${setup.score} is below the backtested minimum of ${r.minScore}`;
    }
    if (r.disabledInstruments.includes(setup.instrumentId)) {
      return `${setup.instrumentId} showed no edge in the backtest and is disabled by the profile`;
    }
    if (r.allowedDirections && !r.allowedDirections.includes(setup.direction)) {
      return `${setup.direction} setups are not in the backtested profile`;
    }
    if (r.minBiasStrength && setup.biasStrength !== r.minBiasStrength) {
      return `Bias strength "${setup.biasStrength}" is below the backtested minimum "${r.minBiasStrength}"`;
    }
    const missing = (r.requiredConfirmations || []).filter((id) => !setup.confirmations.includes(id));
    if (missing.length) {
      return `Missing confirmation(s) the backtest found necessary: ${missing.join(', ')}`;
    }
    const features = setup.features || [];
    const lacking = (r.requiredFeatures || []).filter((f) => !hasFeature(features, f));
    if (lacking.length) return `Lacks the pattern(s) the bot learned pay: ${lacking.join(', ')}`;
    const bad = (r.excludedFeatures || []).filter((f) => hasFeature(features, f));
    if (bad.length) return `Shows pattern(s) the bot learned lose: ${bad.join(', ')}`;
    return 'Does not match the backtested profile';
  }

  /** One line for the startup log. */
  describe() {
    if (!this.loaded) return 'no edge profile loaded — every setup that clears the gates will alert';
    const r = this.rules;
    const bits = [`score >= ${r.minScore}`];
    if (r.requiredConfirmations.length) bits.push(`requires ${r.requiredConfirmations.join(' + ')}`);
    if (r.minBiasStrength) bits.push(`bias >= ${r.minBiasStrength}`);
    if (r.disabledInstruments.length) bits.push(`excludes ${r.disabledInstruments.join(', ')}`);
    if ((r.requiredFeatures || []).length) bits.push(`needs ${r.requiredFeatures.join(' + ')}`);
    if ((r.excludedFeatures || []).length) bits.push(`avoids ${r.excludedFeatures.join(', ')}`);
    const state = this.validated ? 'validated' : this.enforceUnvalidated ? 'UNVALIDATED, enforced anyway' : 'UNVALIDATED, not enforced';
    return `${bits.join(', ')} (${state}, generated ${this.data.generatedAt})`;
  }
}

module.exports = { EdgeProfile, PROFILE_VERSION };
