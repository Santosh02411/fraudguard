/**
 * Idempotency keys (feature: safe retries on POST /transactions — see
 * middleware/idempotency.js for the actual request-handling logic).
 * This repository is deliberately just storage + one cross-dialect
 * helper (isUniqueViolation) — all the "what does pending vs completed
 * mean" logic lives in the middleware, not scattered across both.
 */

const db = require('../config/database');

async function find(userId, key) {
  return db.get('SELECT * FROM idempotency_keys WHERE user_id = ? AND idempotency_key = ?', [userId, key]);
}

/** Reserves a key by inserting a 'pending' row before the request is
 * actually processed — the UNIQUE(user_id, idempotency_key) constraint
 * is what makes two genuinely concurrent requests with the same key
 * race safely: the loser's INSERT fails and the caller (see
 * isUniqueViolation below) treats that as "already in progress"
 * instead of both proceeding to double-submit the transaction. */
async function reserve({ userId, key, requestHash, expiresAt }) {
  return db.insert(
    'INSERT INTO idempotency_keys (user_id, idempotency_key, request_hash, status, expires_at) VALUES (?, ?, ?, \'pending\', ?)',
    [userId, key, requestHash, expiresAt]
  );
}

async function complete(id, responseStatus, responseBody) {
  return db.run(
    "UPDATE idempotency_keys SET status = 'completed', response_status = ?, response_body = ? WHERE id = ?",
    [responseStatus, responseBody, id]
  );
}

async function remove(id) {
  return db.run('DELETE FROM idempotency_keys WHERE id = ?', [id]);
}

/** SQLite (better-sqlite3) and Postgres (pg) report unique-constraint
 * violations with completely different error shapes — this is the one
 * place that needs to know both, so middleware/idempotency.js's retry
 * logic doesn't have to. */
function isUniqueViolation(err) {
  return err?.code === '23505' /* Postgres */ || /SQLITE_CONSTRAINT/.test(err?.code || '') /* better-sqlite3 */;
}

module.exports = { find, reserve, complete, remove, isUniqueViolation };
