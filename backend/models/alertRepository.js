const db = require('../config/database');

/** See transactionRepository.splitTotal — same one-query-for-page-and-count trick. */
function splitTotal(rows) {
  const total = rows.length > 0 ? Number(rows[0].total) : 0;
  return { rows: rows.map(({ total: _total, ...rest }) => rest), total };
}

/**
 * Builds the shared WHERE clause + params for the filter fields both
 * forUser and allWithUsername accept (status, riskLevel, merchant,
 * date range, amount range, assignedTo) — kept in one place so the two
 * queries can't drift out of sync on what a given filter means.
 * `baseConditions`/`baseParams` seed it with the caller's own required
 * condition (e.g. `a.user_id = ?`).
 */
function buildFilterClause(filters, baseConditions, baseParams) {
  const conditions = [...baseConditions];
  const params = [...baseParams];

  if (filters.status) {
    conditions.push('a.status = ?');
    params.push(filters.status);
  }
  if (filters.riskLevel) {
    conditions.push('a.risk_level = ?');
    params.push(filters.riskLevel);
  }
  if (filters.merchant) {
    conditions.push('t.merchant LIKE ?');
    params.push(`%${filters.merchant}%`);
  }
  if (filters.dateFrom) {
    conditions.push('a.created_at >= ?');
    params.push(filters.dateFrom);
  }
  if (filters.dateTo) {
    conditions.push('a.created_at <= ?');
    params.push(filters.dateTo);
  }
  if (filters.amountMin !== undefined) {
    conditions.push('t.amount >= ?');
    params.push(filters.amountMin);
  }
  if (filters.amountMax !== undefined) {
    conditions.push('t.amount <= ?');
    params.push(filters.amountMax);
  }
  if (filters.assignedTo !== undefined) {
    conditions.push('a.assigned_to = ?');
    params.push(filters.assignedTo);
  }

  return { where: conditions.join(' AND '), params };
}

async function forUser(userId, { page = 1, limit = 50, ...filters } = {}) {
  const offset = (page - 1) * limit;
  const { where, params } = buildFilterClause(filters, ['a.user_id = ?'], [userId]);
  const rows = await db.all(`
    SELECT a.*, t.merchant, t.amount, assignee.username as assignee_username, COUNT(*) OVER() as total
    FROM alerts a
    JOIN transactions t ON a.transaction_id = t.id
    LEFT JOIN users assignee ON a.assigned_to = assignee.id
    WHERE ${where}
    ORDER BY a.created_at DESC LIMIT ? OFFSET ?
  `, [...params, limit, offset]);
  return splitTotal(rows);
}

async function allWithUsername({ page = 1, limit = 50, ...filters } = {}) {
  const offset = (page - 1) * limit;
  const { where, params } = buildFilterClause(filters, ['1=1'], []);
  const rows = await db.all(`
    SELECT a.*, t.merchant, t.amount, u.username, assignee.username as assignee_username, COUNT(*) OVER() as total
    FROM alerts a
    JOIN transactions t ON a.transaction_id = t.id
    JOIN users u ON a.user_id = u.id
    LEFT JOIN users assignee ON a.assigned_to = assignee.id
    WHERE ${where}
    ORDER BY a.created_at DESC LIMIT ? OFFSET ?
  `, [...params, limit, offset]);
  return splitTotal(rows);
}

async function findById(id) {
  return db.get('SELECT * FROM alerts WHERE id = ?', [id]);
}

/** Same shape as forUser/allWithUsername's rows (joined with the
 * transaction and owner), for the single-alert view endpoint. Includes
 * the extra transaction columns (feature: LLM-generated explanations)
 * needed to build/cache a plain-language explanation without a second
 * query — category/location/card_type for context, fraud_score/
 * fraud_reasons/shap_explanation/hard_flag_triggered/scoring_method as
 * the actual signals explained, plain_language_explanation as the cache. */
async function findByIdWithDetails(id) {
  return db.get(`
    SELECT a.*, t.merchant, t.amount, t.category, t.location, t.card_type,
      t.fraud_score, t.fraud_reasons, t.shap_explanation, t.hard_flag_triggered,
      t.scoring_method, t.plain_language_explanation,
      u.username, assignee.username as assignee_username
    FROM alerts a
    JOIN transactions t ON a.transaction_id = t.id
    JOIN users u ON a.user_id = u.id
    LEFT JOIN users assignee ON a.assigned_to = assignee.id
    WHERE a.id = ?
  `, [id]);
}

/**
 * Resolves an alert with an analyst's verdict — the whole point of this
 * endpoint (see schemas/alertSchemas.js's comment on why verdict is
 * required, not optional). `verdict: 'confirmed_fraud'` vs.
 * `'false_positive'` is what transactionRepository.fraudDeviceAndIpBlacklist
 * actually reads to decide whether this transaction's device/IP belongs
 * on the dynamic blacklist — resolving without a verdict would leave
 * that feedback loop open.
 */
async function resolve(id, { verdict, note, resolvedBy }) {
  return db.run(
    `UPDATE alerts
     SET resolved = 1, status = 'resolved', verdict = ?, resolution_note = ?, resolved_by = ?, resolved_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [verdict, note || null, resolvedBy, id]
  );
}

/**
 * Assigns (or unassigns, if assigneeId is null) an alert to an analyst.
 * Auto-transitions status open <-> in_review to reflect who's working
 * it — but never touches a status of 'resolved', since assignment after
 * the fact (e.g. re-triage) shouldn't reopen a closed case.
 */
async function assign(id, assigneeId) {
  return db.run(
    `UPDATE alerts
     SET assigned_to = ?,
         status = CASE
           WHEN status = 'resolved' THEN status
           WHEN ? IS NOT NULL THEN 'in_review'
           ELSE 'open'
         END
     WHERE id = ?`,
    [assigneeId, assigneeId, id]
  );
}

/**
 * Fetches multiple alerts by id in one query — used by the bulk-resolve
 * route (feature: bulk actions) to validate ownership/existence for the
 * whole batch before touching any of them, rather than looping one
 * findById call per id.
 */
async function findByIds(ids) {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  return db.all(`SELECT * FROM alerts WHERE id IN (${placeholders})`, ids);
}

/**
 * Resolves a batch of alerts with the same verdict/note in one UPDATE
 * (feature: bulk actions) — a real ops sweep ("mark this whole set of
 * false-positive card-testing alerts") shouldn't cost one round trip
 * per alert. The caller (routes/alerts.js) is responsible for having
 * already verified ownership of every id in the batch.
 */
async function bulkResolve(ids, { verdict, note, resolvedBy }) {
  if (ids.length === 0) return { changes: 0 };
  const placeholders = ids.map(() => '?').join(', ');
  return db.run(
    `UPDATE alerts
     SET resolved = 1, status = 'resolved', verdict = ?, resolution_note = ?, resolved_by = ?, resolved_at = CURRENT_TIMESTAMP
     WHERE id IN (${placeholders})`,
    [verdict, note || null, resolvedBy, ...ids]
  );
}

async function countUnresolved() {
  const row = await db.get('SELECT COUNT(*) as count FROM alerts WHERE resolved = 0');
  return Number(row.count);
}

/**
 * Inserts one alert. `created_at` optional, same reasoning as
 * transactionRepository.insert().
 */
async function insert(alert) {
  const cols = ['transaction_id', 'user_id', 'message', 'risk_level'];
  const values = [alert.transaction_id, alert.user_id, alert.message, alert.risk_level];
  if (alert.created_at) {
    cols.push('created_at');
    values.push(alert.created_at);
  }
  const placeholders = cols.map(() => '?').join(', ');
  return db.insert(`INSERT INTO alerts (${cols.join(', ')}) VALUES (${placeholders})`, values);
}

module.exports = {
  forUser, allWithUsername, findById, findByIdWithDetails, findByIds,
  resolve, bulkResolve, assign, countUnresolved, insert,
};
