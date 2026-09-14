const express = require('express');
const router = express.Router();
const alertRepository = require('../models/alertRepository');
const userRepository = require('../models/userRepository');
const transactionRepository = require('../models/transactionRepository');
const explanationService = require('../services/explanationService');
const { authMiddleware } = require('../middleware/auth');
const { AppError, asyncHandler } = require('../middleware/errorHandler');
const { validate } = require('../middleware/validate');
const alertSchemas = require('../schemas/alertSchemas');
const { pagination, paginationMeta } = require('../schemas/paginationSchema');
const { audit } = require('../middleware/auditLog');
const csvService = require('../services/csvService');

// GET /api/alerts?page=&limit=&status=&riskLevel=&merchant=&dateFrom=&dateTo=&amountMin=&amountMax=&assignedTo=
// Paginated + filterable alerts — the case-management filter bar. Regular
// users see only their own alerts; admins see everyone's.
const listQuerySchema = pagination.merge(alertSchemas.listQuery);
router.get('/', authMiddleware, validate({ query: listQuerySchema }), asyncHandler(async (req, res) => {
  const { page, limit, ...filters } = req.query;
  const { rows: alerts, total } = req.user.role === 'admin'
    ? await alertRepository.allWithUsername({ page, limit, ...filters })
    : await alertRepository.forUser(req.user.id, { page, limit, ...filters });
  res.json({ alerts, pagination: paginationMeta({ page, limit, total }) });
}));

// PATCH /api/alerts/bulk-resolve - resolve a batch of alerts with the
// same verdict/note in one request (feature: bulk actions — a real
// triage sweep, e.g. clearing a batch of card-testing false positives,
// shouldn't cost one click per alert). Fails the WHOLE batch if any id
// is missing or not owned by the caller, rather than partially applying —
// a bulk action silently succeeding for 8 of 10 requested alerts is a
// worse failure mode than requiring the caller to notice and retry.
router.patch('/bulk-resolve', authMiddleware, validate({ body: alertSchemas.bulkResolveBody }), asyncHandler(async (req, res) => {
  const { alertIds, verdict, note } = req.body;
  const uniqueIds = [...new Set(alertIds)];

  const alerts = await alertRepository.findByIds(uniqueIds);
  const foundIds = new Set(alerts.map((a) => a.id));
  const missingIds = uniqueIds.filter((id) => !foundIds.has(id));
  if (missingIds.length > 0) {
    throw AppError.notFound(`Alert(s) not found: ${missingIds.join(', ')}`);
  }

  if (req.user.role !== 'admin') {
    const notOwned = alerts.some((a) => a.user_id !== req.user.id);
    if (notOwned) throw AppError.forbidden('Not authorized to resolve one or more of the specified alerts');
  }

  await alertRepository.bulkResolve(uniqueIds, { verdict, note, resolvedBy: req.user.id });

  audit({
    req, userId: req.user.id, username: req.user.username,
    action: 'alerts.bulk_resolve', targetType: 'alert', targetId: null, outcome: 'success',
    details: { alertIds: uniqueIds, count: uniqueIds.length, verdict, hasNote: Boolean(note) },
  });

  res.json({ message: `${uniqueIds.length} alert(s) resolved`, resolvedCount: uniqueIds.length, alertIds: uniqueIds });
}));

// GET /api/alerts/export?<same filters as GET />
// CSV export (feature: CSV export). Registered before /:id, same
// ordering reasoning as transactions' export route.
const EXPORT_ROW_CAP = 10000;
router.get('/export', authMiddleware, validate({ query: alertSchemas.listQuery }), asyncHandler(async (req, res) => {
  const filters = req.query;
  const { rows: alerts } = req.user.role === 'admin'
    ? await alertRepository.allWithUsername({ page: 1, limit: EXPORT_ROW_CAP, ...filters })
    : await alertRepository.forUser(req.user.id, { page: 1, limit: EXPORT_ROW_CAP, ...filters });

  const csv = csvService.toCsv(alerts, [
    { key: 'id', header: 'ID' },
    { key: 'created_at', header: 'Date' },
    { key: 'username', header: 'User' }, // only populated for admin exports
    { key: 'merchant', header: 'Merchant' },
    { key: 'amount', header: 'Amount' },
    { key: 'risk_level', header: 'Risk Level' },
    { key: 'status', header: 'Status' },
    { key: 'verdict', header: 'Verdict' },
    { key: 'assignee_username', header: 'Assigned To' },
    { key: 'resolution_note', header: 'Resolution Note' },
    { key: 'message', header: 'Message' },
  ]);

  audit({ req, userId: req.user.id, username: req.user.username, action: 'alerts.export', outcome: 'success', details: { rowCount: alerts.length, filters } });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="alerts-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
}));

// GET /api/alerts/:id - view a single alert (audit trail: who viewed
// which alert and when — feature: audit trail).
router.get('/:id', authMiddleware, validate({ params: alertSchemas.resolveParams }), asyncHandler(async (req, res) => {
  const alert = await alertRepository.findByIdWithDetails(req.params.id);
  if (!alert) throw AppError.notFound('Alert not found');
  if (req.user.role !== 'admin' && alert.user_id !== req.user.id) {
    throw AppError.forbidden('Not authorized');
  }

  audit({ req, userId: req.user.id, username: req.user.username, action: 'alerts.view', targetType: 'alert', targetId: alert.id, outcome: 'success' });

  res.json({ alert });
}));

// GET /api/alerts/:id/explanation - feature: LLM-generated plain-language
// explanations. Turns the transaction's SHAP top-factors (or hard-rule/
// rule-engine reasons, whichever actually decided the score) into ONE
// human sentence for an analyst who doesn't want to read a feature-
// contribution chart. Generated ON DEMAND (not at scoring time for every
// transaction — the 99% of low-risk transactions nobody ever opens an
// alert for shouldn't pay the LLM cost/latency) and cached on the
// transaction row so re-opening the same alert never regenerates it.
router.get('/:id/explanation', authMiddleware, validate({ params: alertSchemas.resolveParams }), asyncHandler(async (req, res) => {
  const alert = await alertRepository.findByIdWithDetails(req.params.id);
  if (!alert) throw AppError.notFound('Alert not found');
  if (req.user.role !== 'admin' && alert.user_id !== req.user.id) {
    throw AppError.forbidden('Not authorized');
  }

  if (alert.plain_language_explanation) {
    return res.json({ explanation: alert.plain_language_explanation, cached: true });
  }

  const txn = transactionRepository.parseRow(alert); // JSON-parses fraud_reasons/shap_explanation/hard_flag_triggered
  const { text, source } = await explanationService.generateExplanation(txn);
  await transactionRepository.savePlainLanguageExplanation(alert.transaction_id, text);

  audit({
    req, userId: req.user.id, username: req.user.username,
    action: 'alerts.explain', targetType: 'alert', targetId: alert.id, outcome: 'success',
    details: { source }, // 'llm' or 'template' — worth tracking since one of these costs money
  });

  res.json({ explanation: text, cached: false });
}));

// PATCH /api/alerts/:id/resolve - resolve an alert with an analyst
// verdict (feature: confirmed-fraud vs. false-positive case management).
// verdict is required, not optional — see schemas/alertSchemas.js's
// comment on why. `confirmed_fraud` feeds the dynamic device/IP
// blacklist (transactionRepository.fraudDeviceAndIpBlacklist);
// `false_positive` explicitly removes it from that signal even if the
// model's original score said otherwise, which is what actually closes
// the feedback loop the old boolean-only resolve couldn't.
router.patch('/:id/resolve', authMiddleware, validate({ params: alertSchemas.resolveParams, body: alertSchemas.resolveBody }), asyncHandler(async (req, res) => {
  const alert = await alertRepository.findById(req.params.id);
  if (!alert) throw AppError.notFound('Alert not found');
  if (req.user.role !== 'admin' && alert.user_id !== req.user.id) {
    throw AppError.forbidden('Not authorized');
  }
  const { verdict, note } = req.body;
  await alertRepository.resolve(req.params.id, { verdict, note, resolvedBy: req.user.id });

  audit({
    req, userId: req.user.id, username: req.user.username,
    action: 'alerts.resolve', targetType: 'alert', targetId: alert.id, outcome: 'success',
    details: { verdict, hasNote: Boolean(note) },
  });

  const updated = await alertRepository.findByIdWithDetails(req.params.id);
  res.json({ message: 'Alert resolved', alert: updated });
}));

// PATCH /api/alerts/:id/assign - assign (or unassign, with assigneeId:
// null) an alert to an analyst (feature: case assignment). Admin-only:
// only admins currently have visibility across every user's alerts, so
// only admins can meaningfully triage/assign them. The assignee must
// themselves be an admin for the same reason — assigning a case to
// someone who can't see the full alert queue wouldn't make sense.
router.patch('/:id/assign', authMiddleware, validate({ params: alertSchemas.resolveParams, body: alertSchemas.assignBody }), asyncHandler(async (req, res) => {
  if (req.user.role !== 'admin') throw AppError.forbidden('Only admins can assign alerts');

  const alert = await alertRepository.findById(req.params.id);
  if (!alert) throw AppError.notFound('Alert not found');

  const { assigneeId } = req.body;
  let assignee = null;
  if (assigneeId !== null) {
    assignee = await userRepository.findById(assigneeId);
    if (!assignee) throw AppError.notFound('Assignee not found');
    if (assignee.role !== 'admin') throw AppError.badRequest('Alerts can only be assigned to admin users');
  }

  await alertRepository.assign(req.params.id, assigneeId);

  audit({
    req, userId: req.user.id, username: req.user.username,
    action: 'alerts.assign', targetType: 'alert', targetId: alert.id, outcome: 'success',
    details: { assigneeId, assigneeUsername: assignee?.username ?? null },
  });

  const updated = await alertRepository.findByIdWithDetails(req.params.id);
  res.json({ message: assigneeId ? 'Alert assigned' : 'Alert unassigned', alert: updated });
}));

module.exports = router;
