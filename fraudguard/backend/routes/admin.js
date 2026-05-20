const express = require('express');
const router = express.Router();
const { getDb } = require('../models/db');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

// All admin routes require auth + admin role
router.use(authMiddleware, adminMiddleware);

// GET /api/admin/users
router.get('/users', (req, res) => {
  const db = getDb();
  const users = db.prepare(`
    SELECT u.id, u.username, u.email, u.role, u.created_at,
      COUNT(t.id) as total_transactions,
      COALESCE(SUM(t.is_fraud), 0) as fraud_count,
      CASE WHEN COUNT(t.id) > 0
        THEN ROUND(SUM(t.is_fraud) * 100.0 / COUNT(t.id), 2)
        ELSE 0 END as fraud_rate
    FROM users u
    LEFT JOIN transactions t ON t.user_id = u.id
    GROUP BY u.id
    ORDER BY u.created_at ASC
  `).all();
  res.json({ users });
});

// PATCH /api/admin/users/:id/role
router.patch('/users/:id/role', (req, res) => {
  const { role } = req.body;
  if (!['admin', 'user'].includes(role)) {
    return res.status(400).json({ error: 'Role must be admin or user' });
  }
  // Prevent removing own admin role
  if (parseInt(req.params.id) === req.user.id && role === 'user') {
    return res.status(400).json({ error: 'Cannot demote yourself' });
  }
  const db = getDb();
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
  res.json({ message: `User role updated to ${role}` });
});

// GET /api/admin/stats
router.get('/stats', (req, res) => {
  const db = getDb();
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  const txnStats = db.prepare(`
    SELECT COUNT(*) as total, COALESCE(SUM(is_fraud), 0) as fraud_count
    FROM transactions
  `).get();
  const alertCount = db.prepare('SELECT COUNT(*) as count FROM alerts WHERE resolved = 0').get().count;
  const fraud_rate = txnStats.total > 0
    ? parseFloat(((txnStats.fraud_count / txnStats.total) * 100).toFixed(2))
    : 0;

  res.json({
    total_users: userCount,
    total_transactions: txnStats.total,
    active_alerts: alertCount,
    system_fraud_rate: fraud_rate,
  });
});

module.exports = router;
