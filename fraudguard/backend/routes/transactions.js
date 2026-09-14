const express = require('express');
const router = express.Router();
const { getDb } = require('../models/db');
const { authMiddleware } = require('../middleware/auth');
const { analyzeTransaction } = require('../models/fraudEngine');

// GET /api/transactions - get transactions for logged-in user (admin sees all)
router.get('/', authMiddleware, (req, res) => {
  const db = getDb();
  let txns;
  if (req.user.role === 'admin') {
    txns = db.prepare(`
      SELECT t.*, u.username FROM transactions t
      JOIN users u ON t.user_id = u.id
      ORDER BY t.created_at DESC LIMIT 100
    `).all();
  } else {
    txns = db.prepare(`
      SELECT * FROM transactions WHERE user_id = ?
      ORDER BY created_at DESC LIMIT 100
    `).all(req.user.id);
  }
  // Parse fraud_reasons JSON string
  txns = txns.map(t => ({ ...t, fraud_reasons: JSON.parse(t.fraud_reasons || '[]') }));
  res.json({ transactions: txns });
});

// POST /api/transactions - create new transaction
router.post('/', authMiddleware, (req, res) => {
  const { amount, merchant, category, location, card_type } = req.body;

  if (!amount || !merchant || !category || !location || !card_type) {
    return res.status(400).json({ error: 'All fields required: amount, merchant, category, location, card_type' });
  }
  if (isNaN(amount) || Number(amount) <= 0) {
    return res.status(400).json({ error: 'Amount must be a positive number' });
  }

  const db = getDb();

  // Get recent transactions for velocity check
  const recentTxns = db.prepare(
    'SELECT created_at FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20'
  ).all(req.user.id);

  const txnData = { amount: Number(amount), merchant, category, location, card_type };
  const analysis = analyzeTransaction(txnData, recentTxns);

  const result = db.prepare(`
    INSERT INTO transactions (user_id, amount, merchant, category, location, card_type, is_fraud, fraud_score, risk_level, fraud_reasons, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.user.id,
    txnData.amount,
    merchant,
    category,
    location,
    card_type,
    analysis.is_fraud,
    analysis.fraud_score,
    analysis.risk_level,
    JSON.stringify(analysis.fraud_reasons),
    'completed'
  );

  const txnId = result.lastInsertRowid;

  // Create alert if high or medium risk
  if (analysis.risk_level === 'high' || analysis.risk_level === 'medium') {
    const riskLabel = analysis.risk_level === 'high' ? 'High risk' : 'Medium risk';
    db.prepare(`
      INSERT INTO alerts (transaction_id, user_id, message, risk_level)
      VALUES (?, ?, ?, ?)
    `).run(
      txnId,
      req.user.id,
      `${riskLabel} transaction detected at ${merchant}. Amount: $${txnData.amount.toFixed(2)}`,
      analysis.risk_level
    );
  }

  const newTxn = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txnId);

  res.status(201).json({
    transaction: { ...newTxn, fraud_reasons: analysis.fraud_reasons },
    analysis: {
      is_fraud: analysis.is_fraud,
      fraud_score: analysis.fraud_score,
      risk_level: analysis.risk_level,
      fraud_reasons: analysis.fraud_reasons,
      message: analysis.is_fraud
        ? '🚨 Fraud detected! This transaction has been flagged.'
        : analysis.risk_level === 'medium'
        ? '⚠️ Suspicious transaction. Please review carefully.'
        : '✅ Transaction looks safe.',
    },
  });
});

// GET /api/transactions/stats - dashboard stats for logged-in user
router.get('/stats', authMiddleware, (req, res) => {
  const db = getDb();
  let stats;

  if (req.user.role === 'admin') {
    stats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(is_fraud) as fraud_count,
        SUM(amount) as total_amount,
        AVG(fraud_score) as avg_fraud_score
      FROM transactions
    `).get();
  } else {
    stats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(is_fraud) as fraud_count,
        SUM(amount) as total_amount,
        AVG(fraud_score) as avg_fraud_score
      FROM transactions WHERE user_id = ?
    `).get(req.user.id);
  }

  const fraud_rate = stats.total > 0 ? ((stats.fraud_count / stats.total) * 100).toFixed(2) : '0.00';

  res.json({
    total_transactions: stats.total || 0,
    fraud_count: stats.fraud_count || 0,
    fraud_rate: parseFloat(fraud_rate),
    total_amount: parseFloat((stats.total_amount || 0).toFixed(2)),
    avg_fraud_score: parseFloat((stats.avg_fraud_score || 0).toFixed(2)),
  });
});

module.exports = router;
