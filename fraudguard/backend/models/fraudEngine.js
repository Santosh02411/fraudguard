/**
 * FraudGuard Detection Engine
 * Analyzes transactions and assigns fraud scores / risk levels
 */

const HIGH_RISK_MERCHANTS = ['Casino', 'Gambling', 'CryptoExchange', 'WireTransfer'];
const HIGH_RISK_CATEGORIES = ['gambling', 'crypto', 'wire_transfer'];
const HIGH_RISK_LOCATIONS = ['Nigeria', 'Unknown', 'Anonymous'];

const AMOUNT_THRESHOLDS = {
  low: 500,
  medium: 1500,
  high: 3000,
};

function analyzeTransaction(txn, recentTxns = []) {
  const reasons = [];
  let score = 0;

  // --- Amount analysis ---
  if (txn.amount > AMOUNT_THRESHOLDS.high) {
    score += 40;
    reasons.push(`Very high transaction amount ($${txn.amount.toFixed(2)})`);
  } else if (txn.amount > AMOUNT_THRESHOLDS.medium) {
    score += 20;
    reasons.push(`High transaction amount ($${txn.amount.toFixed(2)})`);
  } else if (txn.amount > AMOUNT_THRESHOLDS.low) {
    score += 10;
  }

  // --- Merchant risk ---
  if (HIGH_RISK_MERCHANTS.some(m => txn.merchant.toLowerCase().includes(m.toLowerCase()))) {
    score += 30;
    reasons.push(`High-risk merchant: ${txn.merchant}`);
  }

  // --- Category risk ---
  if (HIGH_RISK_CATEGORIES.includes(txn.category.toLowerCase())) {
    score += 25;
    reasons.push(`Suspicious transaction category: ${txn.category}`);
  }

  // --- Location risk ---
  if (HIGH_RISK_LOCATIONS.some(l => txn.location.toLowerCase().includes(l.toLowerCase()))) {
    score += 20;
    reasons.push(`High-risk location: ${txn.location}`);
  }

  // --- Velocity check (multiple transactions in short window) ---
  const recentCount = recentTxns.filter(t => {
    const diff = Date.now() - new Date(t.created_at).getTime();
    return diff < 60 * 60 * 1000; // last 1 hour
  }).length;

  if (recentCount >= 5) {
    score += 25;
    reasons.push(`High transaction velocity: ${recentCount} transactions in last hour`);
  } else if (recentCount >= 3) {
    score += 10;
    reasons.push(`Elevated transaction velocity: ${recentCount} transactions in last hour`);
  }

  // --- Card type risk ---
  if (txn.card_type === 'prepaid') {
    score += 15;
    reasons.push('Prepaid card used (higher fraud risk)');
  }

  // Cap score at 100
  score = Math.min(score, 100);

  // Determine risk level
  let risk_level;
  let is_fraud;

  if (score >= 70) {
    risk_level = 'high';
    is_fraud = 1;
  } else if (score >= 40) {
    risk_level = 'medium';
    is_fraud = 0;
  } else {
    risk_level = 'low';
    is_fraud = 0;
  }

  return {
    fraud_score: score,
    risk_level,
    is_fraud,
    fraud_reasons: reasons,
  };
}

module.exports = { analyzeTransaction };
