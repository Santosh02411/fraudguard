const express = require('express');
const router = express.Router();
const userRepository = require('../models/userRepository');
const transactionRepository = require('../models/transactionRepository');
const alertRepository = require('../models/alertRepository');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const { AppError, asyncHandler } = require('../middleware/errorHandler');
const { validate } = require('../middleware/validate');
const adminSchemas = require('../schemas/adminSchemas');
const simulator = require('../realtime/simulator');
const auditLogRepository = require('../models/auditLogRepository');
const refreshTokenRepository = require('../models/refreshTokenRepository');
const { audit } = require('../middleware/auditLog');
const { paginationMeta } = require('../schemas/paginationSchema');
const csvService = require('../services/csvService');
const networkRepository = require('../models/networkRepository');
const mlAdminClient = require('../services/mlAdminClient');
const fraudRuleRepository = require('../models/fraudRuleRepository');
const sarReportService = require('../services/sarReportService');

// All admin routes require auth + admin role
router.use(authMiddleware, adminMiddleware);

// GET /api/admin/users
router.get('/users', asyncHandler(async (req, res) => {
  const users = await userRepository.listWithStats();
  res.json({ users });
}));

// PATCH /api/admin/users/:id/role
router.patch(
  '/users/:id/role',
  validate({ params: adminSchemas.updateRoleParams, body: adminSchemas.updateRoleBody }),
  asyncHandler(async (req, res) => {
    const { role } = req.body;
    const { id } = req.params;

    if (id === req.user.id && role === 'user') {
      throw AppError.badRequest('Cannot demote yourself');
    }

    const user = await userRepository.findById(id);
    if (!user) throw AppError.notFound('User not found');

    await userRepository.updateRole(id, role);
    // A role change invalidates trust in that account's existing
    // sessions (e.g. a demoted admin shouldn't keep admin-level access
    // via a refresh token minted before the demotion) — force
    // re-authentication everywhere it's logged in.
    await refreshTokenRepository.revokeAllForUser(id);

    audit({
      req, userId: req.user.id, username: req.user.username,
      action: 'admin.role_change', targetType: 'user', targetId: Number(id), outcome: 'success',
      details: { targetUsername: user.username, oldRole: user.role, newRole: role },
    });

    res.json({ message: `User role updated to ${role}` });
  })
);

// GET /api/admin/stats
router.get('/stats', asyncHandler(async (req, res) => {
  const [userCount, txnStats, alertCount] = await Promise.all([
    userRepository.count(),
    transactionRepository.adminSummary(),
    alertRepository.countUnresolved(),
  ]);

  const total = Number(txnStats.total) || 0;
  const fraudCount = Number(txnStats.fraud_count) || 0;
  const fraud_rate = total > 0 ? parseFloat(((fraudCount / total) * 100).toFixed(2)) : 0;

  res.json({
    total_users: userCount,
    total_transactions: total,
    active_alerts: alertCount,
    system_fraud_rate: fraud_rate,
  });
}));

// --- Live transaction feed simulation (realtime/simulator.js) ---
// Demo feature: generates synthetic transactions on an interval, scored
// by the real fraud engine, broadcast to every connected client's Live
// Feed view over the 'simulation-feed' socket room. Admin-only to
// start/stop since it writes synthetic rows attributed to real demo
// accounts; GET /status is safe for any authenticated caller to poll,
// though the socket 'simulation:status' event makes that unnecessary
// for the frontend.

// POST /api/admin/simulation/start
router.post('/simulation/start', validate({ body: adminSchemas.simulationStart }), asyncHandler(async (req, res) => {
  try {
    const status = simulator.start({ ...req.body, startedBy: req.user.username });
    res.json({ message: 'Simulation started', status });
  } catch (err) {
    if (err.code === 'ALREADY_RUNNING') throw AppError.conflict(err.message);
    throw err;
  }
}));

// POST /api/admin/simulation/stop
router.post('/simulation/stop', asyncHandler(async (req, res) => {
  try {
    const status = simulator.stop();
    res.json({ message: 'Simulation stopped', status });
  } catch (err) {
    if (err.code === 'NOT_RUNNING') throw AppError.conflict(err.message);
    throw err;
  }
}));

// GET /api/admin/simulation/status
router.get('/simulation/status', asyncHandler(async (req, res) => {
  res.json({ status: simulator.getStatus() });
}));

// --- Audit trail (feature: who viewed/resolved which alert and when;
// RBAC decisions logged) ---

// GET /api/admin/audit-logs?page=&limit=&action=&targetType=&targetId=&userId=
router.get('/audit-logs', validate({ query: adminSchemas.auditLogQuery }), asyncHandler(async (req, res) => {
  const { page, limit, action, targetType, targetId, userId } = req.query;
  const { rows: logs, total } = await auditLogRepository.list({ page, limit, action, targetType, targetId, userId });
  res.json({ logs, pagination: paginationMeta({ page, limit, total }) });
}));

// GET /api/admin/audit-logs/export?<same filters, no page/limit>
// CSV export (feature: CSV export) — the audit trail is the one export
// source with no per-user ownership scoping to worry about (this whole
// router is admin-only already, via router.use above).
const AUDIT_EXPORT_ROW_CAP = 10000;
router.get('/audit-logs/export', validate({ query: adminSchemas.auditLogExportQuery }), asyncHandler(async (req, res) => {
  const { action, targetType, targetId, userId } = req.query;
  const { rows: logs } = await auditLogRepository.list({ page: 1, limit: AUDIT_EXPORT_ROW_CAP, action, targetType, targetId, userId });

  const csv = csvService.toCsv(logs, [
    { key: 'id', header: 'ID' },
    { key: 'created_at', header: 'Date' },
    { key: 'username', header: 'User' },
    { key: 'action', header: 'Action' },
    { key: 'target_type', header: 'Target Type' },
    { key: 'target_id', header: 'Target ID' },
    { key: 'outcome', header: 'Outcome' },
    { key: 'ip_address', header: 'IP Address' },
  ]);

  audit({ req, userId: req.user.id, username: req.user.username, action: 'admin.audit_logs_export', outcome: 'success', details: { rowCount: logs.length, filters: req.query } });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="audit-logs-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
}));

// GET /api/admin/audit-logs/alert/:id — full "who viewed/resolved this
// alert, and when" history for one specific alert.
router.get('/audit-logs/alert/:id', validate({ params: adminSchemas.idParam }), asyncHandler(async (req, res) => {
  const logs = await auditLogRepository.forTarget('alert', req.params.id);
  res.json({ logs });
}));

// GET /api/admin/alerts/:id/sar-report?format=pdf|csv (feature: SAR-style
// exportable reports) — see services/sarReportService.js for exactly
// what this is and, importantly, what it is NOT (a completed regulatory
// filing). Combines the transaction, why it was flagged, its network/
// dispute status, and its full audit trail into one compliance-ready
// document.
router.get('/alerts/:id/sar-report', validate({ params: adminSchemas.idParam, query: adminSchemas.sarReportQuery }), asyncHandler(async (req, res) => {
  const caseData = await sarReportService.buildCaseData(req.params.id);
  if (!caseData) throw AppError.notFound('Alert not found');

  audit({
    req, userId: req.user.id, username: req.user.username,
    action: 'compliance.sar_export', targetType: 'alert', targetId: caseData.alert_id, outcome: 'success',
    details: { format: req.query.format },
  });

  const filenameBase = `sar-report-alert-${caseData.alert_id}`;
  if (req.query.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.csv"`);
    return res.send(sarReportService.toCsv(caseData));
  }

  const pdfBuffer = await sarReportService.toPdfBuffer(caseData);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.pdf"`);
  res.send(pdfBuffer);
}));

// --- Fraud rings (feature: network/graph-based fraud ring detection —
// models/networkRepository.js) ---

// GET /api/admin/fraud-rings — every cluster of >= 2 accounts linked by
// a shared device fingerprint or IP address, with a risk verdict
// ('high' = includes a confirmed-fraud account, 'watch' = unusually
// large cluster with none confirmed yet, 'low' = small overlap).
router.get('/fraud-rings', asyncHandler(async (req, res) => {
  const rings = await networkRepository.detectRings({ minSize: 2 });
  res.json({ rings });
}));

// --- ML model monitoring & shadow/canary deployment (proxied to
// ml_service — see services/mlAdminClient.js) ---

// GET /api/admin/ml/drift — feature distribution / score drift report
// for the currently-active model version (Population Stability Index
// per feature, plus a score-distribution comparison).
router.get('/ml/drift', asyncHandler(async (req, res) => {
  const drift = await mlAdminClient.getDrift();
  res.json(drift);
}));

// POST /api/admin/ml/drift/reset — clears the live-traffic buffer the
// drift report is computed from (e.g. right after promoting a new
// model, so drift is measured against fresh traffic, not the old
// model's).
router.post('/ml/drift/reset', asyncHandler(async (req, res) => {
  const result = await mlAdminClient.resetDrift();
  audit({ req, userId: req.user.id, username: req.user.username, action: 'ml.drift_reset', outcome: 'success' });
  res.json(result);
}));

// GET /api/admin/ml/versions — every version in the model registry.
router.get('/ml/versions', asyncHandler(async (req, res) => {
  const result = await mlAdminClient.listVersions();
  res.json(result);
}));

// GET /api/admin/ml/shadow/status — comparison stats between the
// primary (serving) model and a shadow/canary model scoring the same
// live traffic in parallel, without affecting any actual decision.
router.get('/ml/shadow/status', asyncHandler(async (req, res) => {
  const status = await mlAdminClient.getShadowStatus();
  res.json(status);
}));

// POST /api/admin/ml/shadow/set { version } — starts shadow-scoring a
// registry version alongside the active one.
router.post('/ml/shadow/set', validate({ body: adminSchemas.shadowSetBody }), asyncHandler(async (req, res) => {
  const result = await mlAdminClient.setShadow(req.body.version);
  audit({ req, userId: req.user.id, username: req.user.username, action: 'ml.shadow_set', outcome: 'success', details: { version: req.body.version } });
  res.json(result);
}));

// POST /api/admin/ml/shadow/clear — stops shadow-scoring.
router.post('/ml/shadow/clear', asyncHandler(async (req, res) => {
  const result = await mlAdminClient.clearShadow();
  audit({ req, userId: req.user.id, username: req.user.username, action: 'ml.shadow_clear', outcome: 'success' });
  res.json(result);
}));

// POST /api/admin/ml/shadow/promote — promotes the current shadow
// version to primary. The point of running it in parallel first: by now
// GET /ml/shadow/status already shows how it compared to the incumbent
// on real traffic, not just on the training-time held-out test set.
router.post('/ml/shadow/promote', asyncHandler(async (req, res) => {
  const result = await mlAdminClient.promoteShadow();
  audit({ req, userId: req.user.id, username: req.user.username, action: 'ml.shadow_promote', outcome: 'success', details: result });
  res.json(result);
}));

// --- Configurable fraud rules (feature: admin rule builder — see
// models/fraudRuleRepository.js, fraudEngine.js's checkHardRules) ---

// GET /api/admin/fraud-rules — every rule, enabled or not, newest edits
// visible via updated_by_username/updated_at.
router.get('/fraud-rules', asyncHandler(async (req, res) => {
  const rules = await fraudRuleRepository.listRules();
  res.json({ rules });
}));

// POST /api/admin/fraud-rules — add a new blacklist entry or amount cap.
// Takes effect on the very next transaction scored (routes/transactions.js
// re-reads getActiveRuleConfig() per request — no restart/deploy needed,
// which is the entire point of this feature over the old hardcoded
// HARD_RULES_CONFIG).
router.post('/fraud-rules', validate({ body: adminSchemas.fraudRuleCreateBody }), asyncHandler(async (req, res) => {
  const rule = await fraudRuleRepository.createRule({ ...req.body, createdBy: req.user.id });

  audit({
    req, userId: req.user.id, username: req.user.username,
    action: 'fraud_rules.create', targetType: 'fraud_rule', targetId: rule.id, outcome: 'success',
    details: { rule_type: rule.rule_type, value: rule.value, threshold: rule.threshold },
  });

  res.status(201).json({ message: 'Rule created', rule });
}));

// POST /api/admin/fraud-rules/preview — feature: rule impact preview.
// Dry-runs a candidate rule (same body shape as create — rule_type plus
// value or threshold) against transactions already on file, WITHOUT
// creating it, so an admin can see how broad a new blacklist entry or a
// lower amount cap would actually be before turning it on. Registered
// before PATCH/DELETE .../:id below, but that's moot anyway since this
// is POST to a literal "preview" segment, never confusable with a
// numeric :id regardless of method.
router.post('/fraud-rules/preview', validate({ body: adminSchemas.fraudRuleCreateBody }), asyncHandler(async (req, res) => {
  const { matched_count, sample } = await fraudRuleRepository.previewImpact(req.body);
  res.json({ matched_count, sample });
}));

// PATCH /api/admin/fraud-rules/:id — edit or enable/disable a rule.
router.patch('/fraud-rules/:id', validate({ params: adminSchemas.idParam, body: adminSchemas.fraudRuleUpdateBody }), asyncHandler(async (req, res) => {
  const existing = await fraudRuleRepository.findById(req.params.id);
  if (!existing) throw AppError.notFound('Fraud rule not found');

  const rule = await fraudRuleRepository.updateRule(req.params.id, req.body, req.user.id);

  audit({
    req, userId: req.user.id, username: req.user.username,
    action: 'fraud_rules.update', targetType: 'fraud_rule', targetId: rule.id, outcome: 'success',
    details: { before: { value: existing.value, threshold: existing.threshold, enabled: !!existing.enabled }, changes: req.body },
  });

  res.json({ message: 'Rule updated', rule });
}));

// DELETE /api/admin/fraud-rules/:id — permanently remove a rule (as
// opposed to PATCH { enabled: false }, which keeps it around, disabled,
// for re-enabling later — both are exposed since "turn it off" and
// "this was a mistake, remove it" are different admin intents worth
// distinguishing in the audit trail).
router.delete('/fraud-rules/:id', validate({ params: adminSchemas.idParam }), asyncHandler(async (req, res) => {
  const existing = await fraudRuleRepository.findById(req.params.id);
  if (!existing) throw AppError.notFound('Fraud rule not found');

  await fraudRuleRepository.deleteRule(req.params.id);

  audit({
    req, userId: req.user.id, username: req.user.username,
    action: 'fraud_rules.delete', targetType: 'fraud_rule', targetId: existing.id, outcome: 'success',
    details: { rule_type: existing.rule_type, value: existing.value, threshold: existing.threshold },
  });

  res.json({ message: 'Rule deleted' });
}));

module.exports = router;
