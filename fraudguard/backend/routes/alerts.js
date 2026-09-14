const express = require('express');
const router = express.Router();
const { getDb } = require('../models/db');
const { authMiddleware } = require('../middleware/auth');

// GET /api/alerts - get alerts
router.get('/', authMiddleware, (req, res) => {
  const db = getDb();
  let alerts;
  if (req.user.role === 'admin') {
    alerts = db.prepare(`
      SELECT a.*, t.merchant, t.amount, u.username
      FROM alerts a
      JOIN transactions t ON a.transaction_id = t.id
      JOIN users u ON a.user_id = u.id
      ORDER BY a.created_at DESC LIMIT 50
    `).all();
  } else {
    alerts = db.prepare(`
      SELECT a.*, t.merchant, t.amount
      FROM alerts a
      JOIN transactions t ON a.transaction_id = t.id
      WHERE a.user_id = ?
      ORDER BY a.created_at DESC LIMIT 50
    `).all(req.user.id);
  }
  res.json({ alerts });
});

// PATCH /api/alerts/:id/resolve - resolve an alert
router.patch('/:id/resolve', authMiddleware, (req, res) => {
  const db = getDb();
  const alert = db.prepare('SELECT * FROM alerts WHERE id = ?').get(req.params.id);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  if (req.user.role !== 'admin' && alert.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  db.prepare('UPDATE alerts SET resolved = 1 WHERE id = ?').run(req.params.id);
  res.json({ message: 'Alert resolved' });
});

module.exports = router;
