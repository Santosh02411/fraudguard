/**
 * Step-Up Authentication Repository
 * ====================================
 * Feature: step-up auth hook. Backs the webhook/API contract that lets
 * a medium-risk transaction be HELD for an extra verification step
 * (OTP, 3DS, or whatever the calling merchant's own auth stack uses)
 * instead of only alerting an analyst after the money has already
 * moved — see routes/transactions.js for the full contract
 * (transaction.step_up_required webhook out, POST .../step-up/verify
 * callback in).
 */

const crypto = require('crypto');
const db = require('../config/database');
const config = require('../config/env');

function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

/** @param {{transactionId: number, method?: string}} params */
async function createChallenge({ transactionId, method = 'otp' }) {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + config.stepUpChallengeTtlMs).toISOString();
  const { lastInsertRowid } = await db.insert(
    `INSERT INTO step_up_challenges (transaction_id, status, method, challenge_token, expires_at)
     VALUES (?, 'pending', ?, ?, ?)`,
    [transactionId, method, token, expiresAt]
  );
  return findById(lastInsertRowid);
}

async function findById(id) {
  return db.get('SELECT * FROM step_up_challenges WHERE id = ?', [id]);
}

async function findByTransactionId(transactionId) {
  return db.get('SELECT * FROM step_up_challenges WHERE transaction_id = ? ORDER BY created_at DESC LIMIT 1', [transactionId]);
}

async function findByToken(token) {
  return db.get('SELECT * FROM step_up_challenges WHERE challenge_token = ?', [token]);
}

function isExpired(challenge) {
  return new Date(challenge.expires_at).getTime() < Date.now();
}

/**
 * Lazily resolves an already-due-but-still-"pending" challenge to
 * "expired" — there's no background sweep for this (unlike the webhook
 * retry queue, an expired challenge doesn't need to DO anything on
 * expiry, just stop being valid), so the check happens at the two
 * points that actually care: verify() below, and GET .../step-up status
 * checks.
 */
async function expireIfDue(challenge) {
  if (challenge.status === 'pending' && isExpired(challenge)) {
    await db.run("UPDATE step_up_challenges SET status = 'expired' WHERE id = ?", [challenge.id]);
    return { ...challenge, status: 'expired' };
  }
  return challenge;
}

async function markVerified(id) {
  await db.run("UPDATE step_up_challenges SET status = 'verified', verified_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);
  return findById(id);
}

async function markFailed(id) {
  await db.run("UPDATE step_up_challenges SET status = 'failed' WHERE id = ?", [id]);
  return findById(id);
}

module.exports = { createChallenge, findById, findByTransactionId, findByToken, isExpired, expireIfDue, markVerified, markFailed };
