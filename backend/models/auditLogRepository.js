/**
 * Audit trail (feature: who viewed/resolved which alert and when; RBAC
 * decisions logged). See middleware/auditLog.js for the write-side
 * helper routes call, and routes/admin.js's GET /audit-logs for the
 * read side.
 */

const db = require('../config/database');

async function insert({ userId, username, action, targetType, targetId, outcome = 'success', ipAddress, details }) {
  return db.insert(
    `INSERT INTO audit_logs (user_id, username, action, target_type, target_id, outcome, ip_address, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId ?? null,
      username ?? null,
      action,
      targetType ?? null,
      targetId ?? null,
      outcome,
      ipAddress ?? null,
      JSON.stringify(details ?? {}),
    ]
  );
}

function parseRow(row) {
  return { ...row, details: JSON.parse(row.details || '{}') };
}

/** All-comers admin view of the trail, newest first, optionally filtered. */
async function list({ page = 1, limit = 50, action, targetType, targetId, userId } = {}) {
  const offset = (page - 1) * limit;
  const clauses = [];
  const params = [];
  if (action) { clauses.push('action = ?'); params.push(action); }
  if (targetType) { clauses.push('target_type = ?'); params.push(targetType); }
  if (targetId) { clauses.push('target_id = ?'); params.push(targetId); }
  if (userId) { clauses.push('user_id = ?'); params.push(userId); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const rows = await db.all(
    `SELECT *, COUNT(*) OVER() as total FROM audit_logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const total = rows.length > 0 ? Number(rows[0].total) : 0;
  return { rows: rows.map(({ total: _total, ...r }) => parseRow(r)), total };
}

/** Full history for one specific target (e.g. "every view/resolve of
 * alert #42, by whom, when") — the direct answer to "who viewed/resolved
 * which alert and when." */
async function forTarget(targetType, targetId) {
  const rows = await db.all(
    'SELECT * FROM audit_logs WHERE target_type = ? AND target_id = ? ORDER BY created_at DESC',
    [targetType, targetId]
  );
  return rows.map(parseRow);
}

module.exports = { insert, list, forTarget };
