/**
 * ML Scoring Client
 * ===================
 * Calls the Python FastAPI ML service (ml_service/app.py) which scores a
 * transaction using the currently-promoted model version (see
 * ml_service/models/registry/).
 *
 * Derives every behavioral feature the model expects from the user's own
 * transaction history in SQLite — the current transaction form only
 * collects amount/merchant/category/location/card_type, so velocity,
 * time-since-last-transaction, spending-pattern deviation, geo-distance,
 * and device/IP novelty are all computed here, server-side, from real
 * history (not sent by the client — a client could lie about those).
 */

const { haversineKm } = require('./geo');
const config = require('../config/env');

const ML_SERVICE_URL = config.mlServiceUrl;
const ML_TIMEOUT_MS = config.mlServiceTimeoutMs;

/**
 * Builds the ML feature payload from the new transaction + the user's
 * recent transaction history (already fetched by the caller, most-recent
 * first, including device_fingerprint/ip_address/location/amount/merchant).
 *
 * @param {Date} [referenceTime] - "now", for velocity/time-since-last
 *   calculations. Defaults to the real current time for live traffic;
 *   the demo seed generator (scripts/generateDemoData.js) passes a
 *   simulated historical timestamp instead, so seeded transactions get
 *   scored against the transaction time they claim to have happened at,
 *   not the moment the seed script actually ran.
 */
function buildFeaturePayload(txn, recentTxns, referenceTime) {
  const now = referenceTime || new Date();
  const oneHourAgo = now.getTime() - 60 * 60 * 1000;

  // --- Velocity ---
  const velocity_last_hour = recentTxns.filter(
    (t) => new Date(t.created_at).getTime() > oneHourAgo
  ).length;

  // --- Time since last transaction ---
  const time_since_last_transaction_minutes = recentTxns.length
    ? (now.getTime() - new Date(recentTxns[0].created_at).getTime()) / 60000
    : 1440; // no history -> treat as "a day since last activity"

  // --- Spending pattern deviation (z-score vs. the user's own history) ---
  const amounts = recentTxns.map((t) => t.amount).filter((a) => typeof a === 'number');
  let spending_zscore = 0;
  let ratio_to_median_purchase_price = 1;
  if (amounts.length >= 3) {
    const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const variance = amounts.reduce((a, b) => a + (b - mean) ** 2, 0) / amounts.length;
    const std = Math.sqrt(variance) || 1;
    spending_zscore = (txn.amount - mean) / std;
    ratio_to_median_purchase_price = txn.amount / (median(amounts) || 1);
  }

  // --- Geo-distance: home location deviation + jump from last transaction ---
  const locations = recentTxns.map((t) => t.location);
  const home_location = mostCommon(locations) || txn.location;
  const distance_from_home = haversineKm(home_location, txn.location);

  const last_location = recentTxns.length ? recentTxns[0].location : txn.location;
  const geo_distance_from_last_km = haversineKm(last_location, txn.location);

  // --- Repeat retailer ---
  const merchants = recentTxns.map((t) => t.merchant);
  const repeat_retailer = merchants.includes(txn.merchant) ? 1 : 0;

  // --- Device / IP fingerprinting ---
  const knownDevices = new Set(recentTxns.map((t) => t.device_fingerprint).filter(Boolean));
  const knownIps = new Set(recentTxns.map((t) => t.ip_address).filter(Boolean));
  const is_new_device = txn.device_fingerprint ? (knownDevices.has(txn.device_fingerprint) ? 0 : 1) : 0;
  let ip_status = 'known';
  if (!txn.ip_address) {
    ip_status = 'unknown';
  } else if (recentTxns.length === 0) {
    ip_status = 'known'; // first-ever transaction: nothing to compare against
  } else if (!knownIps.has(txn.ip_address)) {
    ip_status = 'new';
  }

  const hour = now.getHours();
  const day_of_week = now.getDay();

  return {
    amount: txn.amount,
    category: txn.category,
    location: txn.location,
    card_type: txn.card_type,
    hour,
    day_of_week,
    distance_from_home,
    geo_distance_from_last_km,
    time_since_last_transaction_minutes: Number(time_since_last_transaction_minutes.toFixed(1)),
    ratio_to_median_purchase_price: Number(ratio_to_median_purchase_price.toFixed(3)),
    spending_zscore: Number(spending_zscore.toFixed(3)),
    repeat_retailer,
    used_chip: 0,
    used_pin_number: 0,
    online_order: 1, // web-app transactions are card-not-present by definition
    velocity_last_hour,
    is_new_device,
    ip_status,
  };
}

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mostCommon(arr) {
  if (!arr.length) return null;
  const counts = {};
  let best = arr[0];
  for (const v of arr) {
    counts[v] = (counts[v] || 0) + 1;
    if (counts[v] > (counts[best] || 0)) best = v;
  }
  return best;
}

/**
 * Calls the ML service. Throws on failure/timeout so the caller can fall
 * back to the rule-based engine (see fraudEngine.js hybrid logic).
 */
async function scoreWithML(txn, recentTxns, referenceTime) {
  const payload = buildFeaturePayload(txn, recentTxns, referenceTime);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ML_TIMEOUT_MS);

  try {
    const response = await fetch(`${ML_SERVICE_URL}/predict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`ML service responded with status ${response.status}`);
    }

    const result = await response.json();
    return {
      fraud_score: result.fraud_score,
      risk_level: result.risk_level,
      is_fraud: result.is_fraud,
      model_used: result.model_used,
      model_version: result.model_version,
      top_factors: result.top_factors || [], // [{feature, shap_value, effect}]
      source: 'ml_model',
    };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { scoreWithML, buildFeaturePayload };
