/**
 * FraudGuard Detection Engine
 * =============================
 * A genuine hybrid engine, structured the way production fraud systems
 * (Stripe Radar, PayPal, etc.) actually work:
 *
 *   Layer 1 — HARD RULES (checkHardRules)
 *     Deterministic, fully explainable blacklist/threshold checks that
 *     can OVERRIDE the ML score entirely: known-bad merchants/locations,
 *     an absolute amount cap requiring manual review, and a dynamic
 *     blacklist of devices/IPs seen on previously confirmed fraud. If any
 *     of these trip, the transaction is flagged high-risk regardless of
 *     what the model says — the same way a real system never lets a
 *     statistical score overrule a sanctions-list hit.
 *
 *   Layer 2 — ML PROBABILISTIC SCORE (mlClient.scoreWithML)
 *     The trained model's fraud probability, used for everything that
 *     doesn't hit a hard rule. This is what actually differentiates
 *     "probably fine" from "probably fraud" for the 99% of transactions
 *     that aren't a clean-cut blacklist hit.
 *
 *   Layer 3 — RULE-ENGINE FALLBACK (analyzeTransaction)
 *     The original threshold scorer. Used only if the ML service is
 *     unreachable, so the app degrades gracefully instead of breaking.
 *
 * Alongside these three, an optional NETWORK-RISK signal
 * (models/networkRepository.js) can also feed in: it looks beyond this
 * one transaction/account to whether the account is part of a cluster
 * of accounts linked by shared device/IP identifiers (a fraud ring),
 * which the per-account layers above have no visibility into. Like the
 * dynamic blacklist, it's computed by the caller and passed in already
 * resolved, so this module stays DB-free and easy to unit test.
 *
 * analyzeTransactionHybrid() runs all of this and returns one merged,
 * explainable result — hard-rule reasons, network-risk reasons,
 * rule-engine reasons, and the model's own SHAP-based top factors are
 * all included.
 */

const { scoreWithML } = require('./mlClient');
const logger = require('../config/logger');

const HIGH_RISK_MERCHANTS = ['Casino', 'Gambling', 'CryptoExchange', 'WireTransfer'];
const HIGH_RISK_CATEGORIES = ['gambling', 'crypto', 'wire_transfer'];
// Must match ml_service/utils/feature_engineering.py's HIGH_RISK_LOCATIONS
// and backend/models/geo.js's coordinate table exactly, or the rule engine
// and the ML model disagree about what counts as a risky location.
const HIGH_RISK_LOCATIONS = ['Lagos, NG', 'Unknown', 'Anonymous Proxy'];

const AMOUNT_THRESHOLDS = { low: 500, medium: 1500, high: 3000 };

// --- Layer 1: hard rules -----------------------------------------------

// Default/fallback config, used only when no ruleConfig is passed in
// (e.g. existing unit tests, or a caller that hasn't been updated) —
// this used to be the ONLY config; live traffic now gets its config
// from models/fraudRuleRepository.js's getActiveRuleConfig() instead
// (feature: configurable rule builder — see that file's header comment
// for why), so an admin can edit these from the UI without a deploy.
const HARD_RULES_CONFIG = {
  blacklistedMerchants: ['DarkNet Market', 'FastCash Wire Instant', 'QuickCoin Anonymous'],
  blacklistedLocations: ['Anonymous Proxy'],
  blacklistedDevices: [],
  blacklistedIps: [],
  // Absolute cap: no model score, however low, waives manual review above this.
  absoluteAmountCap: 10000,
};

/**
 * Checks deterministic hard rules: the admin-configured blacklist/cap
 * (ruleConfig, from fraudRuleRepository.getActiveRuleConfig — falls back
 * to the HARD_RULES_CONFIG defaults above if not supplied), PLUS a
 * DYNAMIC blacklist of devices/IPs that have appeared on a previously
 * confirmed-fraud transaction (from ANY user) — a real device/IP
 * reputation signal, separate from the admin's own manually-curated
 * device/IP blacklist entries in ruleConfig.
 *
 * @param {object} txn
 * @param {{devices?: Set<string>, ips?: Set<string>}} dynamicBlacklist
 * @param {{blacklistedMerchants: string[], blacklistedLocations: string[], blacklistedDevices: string[], blacklistedIps: string[], absoluteAmountCap: number}} [ruleConfig]
 */
function checkHardRules(txn, dynamicBlacklist = {}, ruleConfig = HARD_RULES_CONFIG) {
  const reasons = [];
  const merchant = (txn.merchant || '').toLowerCase();

  if (ruleConfig.blacklistedMerchants.some((m) => merchant.includes(m.toLowerCase()))) {
    reasons.push(`Merchant is on the fraud blacklist: "${txn.merchant}"`);
  }
  if (ruleConfig.blacklistedLocations.includes(txn.location)) {
    reasons.push(`Location is on the fraud blacklist: "${txn.location}"`);
  }
  if (txn.amount > ruleConfig.absoluteAmountCap) {
    reasons.push(
      `Amount exceeds the hard cap of $${ruleConfig.absoluteAmountCap.toLocaleString()} — requires manual review regardless of model score`
    );
  }
  if (txn.device_fingerprint && (ruleConfig.blacklistedDevices || []).includes(txn.device_fingerprint)) {
    reasons.push('Device fingerprint is on the admin-configured blacklist');
  }
  if (txn.ip_address && (ruleConfig.blacklistedIps || []).includes(txn.ip_address)) {
    reasons.push('IP address is on the admin-configured blacklist');
  }
  if (txn.device_fingerprint && dynamicBlacklist.devices?.has(txn.device_fingerprint)) {
    reasons.push('Device fingerprint was used on a previously confirmed fraudulent transaction');
  }
  if (txn.ip_address && dynamicBlacklist.ips?.has(txn.ip_address)) {
    reasons.push('IP address was used on a previously confirmed fraudulent transaction');
  }

  return { triggered: reasons.length > 0, reasons };
}

// --- Layer 3: rule-engine fallback (unchanged threshold logic) --------

function analyzeTransaction(txn, recentTxns = [], referenceTime) {
  const now = referenceTime || new Date();
  const reasons = [];
  let score = 0;

  if (txn.amount > AMOUNT_THRESHOLDS.high) {
    score += 40;
    reasons.push(`Very high transaction amount ($${txn.amount.toFixed(2)})`);
  } else if (txn.amount > AMOUNT_THRESHOLDS.medium) {
    score += 20;
    reasons.push(`High transaction amount ($${txn.amount.toFixed(2)})`);
  } else if (txn.amount > AMOUNT_THRESHOLDS.low) {
    score += 10;
  }

  if (HIGH_RISK_MERCHANTS.some((m) => txn.merchant.toLowerCase().includes(m.toLowerCase()))) {
    score += 30;
    reasons.push(`High-risk merchant: ${txn.merchant}`);
  }

  if (HIGH_RISK_CATEGORIES.includes(txn.category.toLowerCase())) {
    score += 25;
    reasons.push(`Suspicious transaction category: ${txn.category}`);
  }

  if (HIGH_RISK_LOCATIONS.some((l) => txn.location.toLowerCase().includes(l.toLowerCase()))) {
    score += 20;
    reasons.push(`High-risk location: ${txn.location}`);
  }

  const recentCount = recentTxns.filter((t) => {
    const diff = now.getTime() - new Date(t.created_at).getTime();
    return diff < 60 * 60 * 1000;
  }).length;

  if (recentCount >= 5) {
    score += 25;
    reasons.push(`High transaction velocity: ${recentCount} transactions in last hour`);
  } else if (recentCount >= 3) {
    score += 10;
    reasons.push(`Elevated transaction velocity: ${recentCount} transactions in last hour`);
  }

  if (txn.card_type === 'prepaid') {
    score += 15;
    reasons.push('Prepaid card used (higher fraud risk)');
  }

  score = Math.min(score, 100);

  let risk_level, is_fraud;
  if (score >= 70) { risk_level = 'high'; is_fraud = 1; }
  else if (score >= 40) { risk_level = 'medium'; is_fraud = 0; }
  else { risk_level = 'low'; is_fraud = 0; }

  return { fraud_score: score, risk_level, is_fraud, fraud_reasons: reasons };
}

// --- Orchestration: hard rules + ML + fallback, merged -----------------

/**
 * @param {object} txn - amount, merchant, category, location, card_type,
 *   device_fingerprint, ip_address
 * @param {array} recentTxns - user's recent transactions (for velocity/
 *   history-derived ML features)
 * @param {{devices?: Set<string>, ips?: Set<string>}} dynamicBlacklist
 * @param {Date} [referenceTime] - see analyzeTransaction/buildFeaturePayload;
 *   defaults to real "now" for live traffic, overridden by the demo seed
 *   generator to backdate scoring to each simulated transaction's own time.
 * @param {{triggered: boolean, hardOverride?: boolean, ring?: {size: number, confirmed_fraud_members: string[]}}} [networkRisk] -
 *   pre-computed by the caller via models/networkRepository.js's
 *   networkRiskForTransaction(). Defaults to "not triggered" so existing
 *   callers/tests that don't pass it keep working unchanged.
 * @param {{blacklistedMerchants: string[], blacklistedLocations: string[], blacklistedDevices: string[], blacklistedIps: string[], absoluteAmountCap: number}} [ruleConfig] -
 *   admin-configured hard-rule thresholds (feature: configurable rule
 *   builder), from models/fraudRuleRepository.js's getActiveRuleConfig().
 *   Defaults to the original hardcoded HARD_RULES_CONFIG so existing
 *   callers/tests keep working unchanged.
 */
async function analyzeTransactionHybrid(txn, recentTxns = [], dynamicBlacklist = {}, referenceTime, networkRisk = { triggered: false }, ruleConfig = HARD_RULES_CONFIG) {
  const hardCheck = checkHardRules(txn, dynamicBlacklist, ruleConfig);
  const ruleResult = analyzeTransaction(txn, recentTxns, referenceTime);
  const networkCheck = checkNetworkRisk(networkRisk);

  let mlResult = null;
  let mlError = null;
  try {
    mlResult = await scoreWithML(txn, recentTxns, referenceTime);
  } catch (err) {
    mlError = err.message;
    logger.warn('ML service unavailable, using rule-engine fallback', { error: mlError });
  }

  const mlReasons = mlResult
    ? (mlResult.top_factors || [])
        .filter((f) => f.effect === 'increased_risk')
        .map((f) => `Model signal: ${humanizeFeature(f.feature)} (SHAP +${f.shap_value.toFixed(3)})`)
    : [];

  // --- Hard rule hit (static/dynamic blacklist, OR a confirmed-fraud
  // account reachable through the shared-identifier graph, possibly via
  // an intermediary account) — overrides everything, regardless of ML ---
  if (hardCheck.triggered || networkCheck.hardOverride) {
    return {
      fraud_score: 100,
      risk_level: 'high',
      is_fraud: 1,
      fraud_reasons: dedupe([...hardCheck.reasons, ...networkCheck.reasons, ...mlReasons, ...ruleResult.fraud_reasons]),
      scoring_method: mlResult ? 'hard_rule_override+ml' : 'hard_rule_override',
      hard_flag_triggered: [...hardCheck.reasons, ...(networkCheck.hardOverride ? networkCheck.reasons : [])],
      model_used: mlResult?.model_used || null,
      model_version: mlResult?.model_version || null,
      ml_score_for_reference: mlResult?.fraud_score ?? null,
      rule_engine_score: ruleResult.fraud_score,
      shap_explanation: mlResult?.top_factors || [],
    };
  }

  // --- No hard-rule/network-override hit: use ML if available, else
  // rule-engine fallback. A "watch"-level network signal (a large
  // cluster of accounts sharing a device/IP, but none confirmed fraud
  // yet) doesn't override the model — it's a topology anomaly, not a
  // policy violation — but it does add its own reason and a score bump,
  // since a probabilistic model trained on per-account behavior has no
  // way to know about this cross-account pattern on its own. ---
  const base = mlResult
    ? {
        fraud_score: mlResult.fraud_score,
        risk_level: mlResult.risk_level,
        is_fraud: mlResult.is_fraud,
        fraud_reasons: dedupe([...mlReasons, ...ruleResult.fraud_reasons]),
        scoring_method: 'ml_model',
        hard_flag_triggered: null,
        model_used: mlResult.model_used,
        model_version: mlResult.model_version,
        rule_engine_score: ruleResult.fraud_score, // kept for comparison/debugging
        shap_explanation: mlResult.top_factors || [],
      }
    : {
        ...ruleResult,
        scoring_method: 'rule_engine_fallback',
        hard_flag_triggered: null,
        model_used: null,
        model_version: null,
        shap_explanation: [],
      };

  if (networkCheck.triggered) {
    const boostedScore = Math.min(100, base.fraud_score + NETWORK_WATCH_SCORE_BOOST);
    return {
      ...base,
      fraud_score: boostedScore,
      risk_level: scoreToRiskLevel(boostedScore),
      fraud_reasons: dedupe([...base.fraud_reasons, ...networkCheck.reasons]),
      scoring_method: `${base.scoring_method}+network_watch`,
    };
  }

  return base;
}

// --- Network-risk layer: shared-identifier graph (see networkRepository.js) ---

// A "watch"-level ring (unusually large, no confirmed fraud yet) bumps
// the score rather than overriding it outright — see the reasoning
// above analyzeTransactionHybrid's `networkCheck.triggered` branch.
const NETWORK_WATCH_SCORE_BOOST = 25;

function checkNetworkRisk(networkRisk = { triggered: false }) {
  if (!networkRisk || !networkRisk.triggered) return { triggered: false, hardOverride: false, reasons: [] };

  const ring = networkRisk.ring || {};
  const reasons = [];
  if (networkRisk.hardOverride) {
    reasons.push(
      `Linked (via a shared device/IP, possibly through another account) to a network of ${ring.size} accounts that includes ${
        (ring.confirmed_fraud_members || []).length
      } account(s) with confirmed fraud history`
    );
  } else {
    reasons.push(
      `This device/IP is shared with ${Math.max((ring.size || 1) - 1, 1)} other account(s) — an unusually large cluster with no confirmed fraud yet, worth a closer look`
    );
  }
  return { triggered: true, hardOverride: !!networkRisk.hardOverride, reasons };
}

function scoreToRiskLevel(score) {
  if (score >= 70) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}

function humanizeFeature(name) {
  return name
    .replace(/^category: /, 'category: ')
    .replace(/^location: /, 'location: ')
    .replace(/^card type: /, 'card type: ')
    .replace(/^IP status: /, 'IP status: ');
}

function dedupe(arr) {
  return [...new Set(arr)];
}

module.exports = { analyzeTransaction, analyzeTransactionHybrid, checkHardRules, checkNetworkRisk };
