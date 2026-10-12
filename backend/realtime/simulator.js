/**
 * Live transaction feed simulator.
 * ===================================
 * Demo/showcase feature: generates synthetic-but-realistic transactions
 * on a timer and runs each one through the SAME hybrid fraud engine
 * (models/fraudEngine.js) real submissions go through — no shortcuts,
 * no fake scores — then persists and broadcasts them exactly like
 * routes/transactions.js does. The only thing "simulated" is where the
 * transaction comes from; the detection is real.
 *
 * Each tick:
 *   1. Picks a random existing non-admin user to attribute the
 *      transaction to (so it's a real FK-valid row, and that user's own
 *      dashboard/alerts update live if they're logged in).
 *   2. Builds a transaction using the same vocabulary the demo-data
 *      seeder and the ML model's training data use (scripts/
 *      demoVocabulary.js), biased toward "safe" or "high-risk" shapes
 *      by the configured `fraudRatio`.
 *   3. Scores it with analyzeTransactionHybrid — hard rules, ML model,
 *      rule-engine fallback, the works.
 *   4. Inserts the transaction (+ an alert, if warranted) and emits the
 *      normal transaction:new/alert:new events, PLUS a
 *      simulation:transaction event to the public 'simulation-feed'
 *      room (see realtime/socketServer.js) carrying the full merged
 *      payload the Live Feed page renders.
 *
 * Single in-process simulation at a time — this is a demo tool, not a
 * load generator, and a Node interval is process-local anyway (doesn't
 * coordinate across instances behind a load balancer).
 */

const crypto = require('crypto');
const transactionRepository = require('../models/transactionRepository');
const alertRepository = require('../models/alertRepository');
const userRepository = require('../models/userRepository');
const { analyzeTransactionHybrid } = require('../models/fraudEngine');
const {
  MERCHANTS_BY_CATEGORY, SAFE_CATEGORIES, HIGH_RISK_CATEGORIES,
  SAFE_LOCATIONS, HIGH_RISK_LOCATIONS, pick, randRange,
} = require('../scripts/demoVocabulary');
const logger = require('../config/logger');
const {
  emitTransactionCreated, emitAlertCreated,
  emitSimulationTransaction, emitSimulationStatus,
} = require('./socketServer');

const CARD_TYPES = ['credit', 'debit', 'prepaid'];
const MIN_INTERVAL_MS = 500;
const MAX_INTERVAL_MS = 15000;
const DEFAULT_INTERVAL_MS = 2500;
const DEFAULT_FRAUD_RATIO = 0.2;

let timer = null;
let busy = false; // guards against overlapping ticks if a tick runs long
let state = {
  running: false,
  intervalMs: DEFAULT_INTERVAL_MS,
  fraudRatio: DEFAULT_FRAUD_RATIO,
  startedAt: null,
  startedBy: null,
  transactionCount: 0,
  fraudCount: 0,
};

function randomDeviceFingerprint() {
  return crypto.randomBytes(8).toString('hex');
}

function randomIp() {
  return `${1 + Math.floor(Math.random() * 254)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${1 + Math.floor(Math.random() * 254)}`;
}

/** Builds one synthetic transaction, biased toward risky shapes ~fraudRatio of the time. */
function buildSyntheticTransaction(fraudRatio) {
  const wantsFraud = Math.random() < fraudRatio;
  const category = wantsFraud ? pick(HIGH_RISK_CATEGORIES) : pick(SAFE_CATEGORIES);
  const merchant = pick(MERCHANTS_BY_CATEGORY[category]);
  const location = wantsFraud && Math.random() < 0.6 ? pick(HIGH_RISK_LOCATIONS) : pick(SAFE_LOCATIONS);
  const amount = wantsFraud
    ? Math.round(randRange(800, 9500) * 100) / 100
    : Math.round(randRange(5, 600) * 100) / 100;
  const card_type = wantsFraud && Math.random() < 0.4 ? 'prepaid' : pick(CARD_TYPES);

  return {
    amount,
    merchant,
    category,
    location,
    card_type,
    device_fingerprint: randomDeviceFingerprint(),
    ip_address: randomIp(),
  };
}

async function tick() {
  if (busy) return; // previous tick still in flight — skip this one rather than pile up
  busy = true;
  try {
    const userIds = await userRepository.listNonAdminIds();
    if (userIds.length === 0) {
      logger.warn('Simulation tick skipped: no non-admin users to attribute transactions to');
      return;
    }
    const userId = pick(userIds);
    const txnData = buildSyntheticTransaction(state.fraudRatio);

    const [recentTxns, blacklist] = await Promise.all([
      transactionRepository.recentForUser(userId),
      transactionRepository.fraudDeviceAndIpBlacklist(),
    ]);

    const analysis = await analyzeTransactionHybrid(txnData, recentTxns, blacklist);

    const { lastInsertRowid: txnId } = await transactionRepository.insert({
      user_id: userId,
      ...txnData,
      is_fraud: analysis.is_fraud,
      fraud_score: analysis.fraud_score,
      risk_level: analysis.risk_level,
      fraud_reasons: analysis.fraud_reasons,
      scoring_method: analysis.scoring_method,
      model_version: analysis.model_version,
      hard_flag_triggered: analysis.hard_flag_triggered,
      shap_explanation: analysis.shap_explanation,
      status: 'completed',
    });

    let newAlert = null;
    if (analysis.risk_level === 'high' || analysis.risk_level === 'medium') {
      const riskLabel = analysis.risk_level === 'high' ? 'High risk' : 'Medium risk';
      const message = `${riskLabel} transaction detected at ${txnData.merchant}. Amount: $${txnData.amount.toFixed(2)}`;
      const { lastInsertRowid: alertId } = await alertRepository.insert({
        transaction_id: txnId, user_id: userId, message, risk_level: analysis.risk_level,
      });
      newAlert = {
        id: alertId, transaction_id: txnId, user_id: userId, message,
        risk_level: analysis.risk_level, resolved: 0, created_at: new Date().toISOString(),
        merchant: txnData.merchant, amount: txnData.amount,
      };
    }

    const newTxn = await transactionRepository.findById(txnId);

    state.transactionCount += 1;
    if (analysis.is_fraud) state.fraudCount += 1;

    emitTransactionCreated(newTxn, { source: 'simulation' });
    if (newAlert) emitAlertCreated(newAlert, { source: 'simulation' });
    emitSimulationTransaction({
      transaction: newTxn,
      analysis: {
        is_fraud: analysis.is_fraud,
        fraud_score: analysis.fraud_score,
        risk_level: analysis.risk_level,
        fraud_reasons: analysis.fraud_reasons,
        scoring_method: analysis.scoring_method,
      },
      stats: { transactionCount: state.transactionCount, fraudCount: state.fraudCount },
    });
  } catch (err) {
    logger.error('Simulation tick failed', { error: err.message, stack: err.stack });
  } finally {
    busy = false;
  }
}

function getStatus() {
  return { ...state };
}

function start({ intervalMs = DEFAULT_INTERVAL_MS, fraudRatio = DEFAULT_FRAUD_RATIO, startedBy } = {}) {
  if (state.running) {
    const err = new Error('Simulation is already running');
    err.code = 'ALREADY_RUNNING';
    throw err;
  }
  const clampedInterval = Math.min(Math.max(intervalMs, MIN_INTERVAL_MS), MAX_INTERVAL_MS);

  state = {
    running: true,
    intervalMs: clampedInterval,
    fraudRatio,
    startedAt: new Date().toISOString(),
    startedBy: startedBy || null,
    transactionCount: 0,
    fraudCount: 0,
  };

  timer = setInterval(tick, clampedInterval);
  logger.info('Live transaction simulation started', { intervalMs: clampedInterval, fraudRatio, startedBy });
  emitSimulationStatus(getStatus());
  tick(); // fire the first one immediately instead of waiting a full interval

  return getStatus();
}

function stop() {
  if (!state.running) {
    const err = new Error('Simulation is not running');
    err.code = 'NOT_RUNNING';
    throw err;
  }
  clearInterval(timer);
  timer = null;
  state = { ...state, running: false };
  logger.info('Live transaction simulation stopped', { transactionCount: state.transactionCount });
  emitSimulationStatus(getStatus());
  return getStatus();
}

module.exports = { start, stop, getStatus, MIN_INTERVAL_MS, MAX_INTERVAL_MS };
