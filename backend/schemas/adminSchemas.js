const { z } = require('zod');

const updateRoleParams = z.object({
  id: z.coerce.number().int().positive(),
});

// Generic `:id` param validator — same shape as updateRoleParams, used
// wherever a route just needs a positive-integer id (e.g. the audit-log
// lookup below), without implying it's specifically about role updates.
const idParam = updateRoleParams;

const updateRoleBody = z.object({
  role: z.enum(['admin', 'user'], { errorMap: () => ({ message: 'Role must be "admin" or "user"' }) }),
});

// Live transaction feed simulation (realtime/simulator.js) — bounds
// mirror simulator.js's MIN/MAX_INTERVAL_MS so a bad request is
// rejected with a clear 400 instead of the simulator silently clamping it.
const simulationStart = z.object({
  intervalMs: z.coerce.number().int()
    .min(500, 'intervalMs must be >= 500')
    .max(15000, 'intervalMs must be <= 15000')
    .default(2500),
  fraudRatio: z.coerce.number()
    .min(0, 'fraudRatio must be >= 0')
    .max(1, 'fraudRatio must be <= 1')
    .default(0.2),
});

// GET /api/admin/audit-logs query filters (feature: audit trail).
const auditLogQuery = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
  action: z.string().min(1).optional(),
  targetType: z.string().min(1).optional(),
  targetId: z.coerce.number().int().positive().optional(),
  userId: z.coerce.number().int().positive().optional(),
});

// GET /api/admin/audit-logs/export filters (feature: CSV export) — same
// filter fields as auditLogQuery, minus page/limit: export always pulls
// from page 1 up to the route's own row cap, not a client-chosen page.
const auditLogExportQuery = auditLogQuery.omit({ page: true, limit: true });

// POST /api/admin/ml/shadow/set body (feature: shadow/canary model
// deployment) — a registry version identifier, e.g. "v3". The ML
// service itself validates that the version actually exists and isn't
// already the active primary; this just rejects an obviously-malformed
// value early with a clear 400.
const shadowSetBody = z.object({
  version: z.string().regex(/^v\d+$/, 'version must look like "v1", "v2", etc.'),
});

// --- Configurable fraud rules (feature: admin rule builder — see
// models/fraudRuleRepository.js, fraudEngine.js's checkHardRules) ---

const FRAUD_RULE_TYPES = ['blacklist_merchant', 'blacklist_location', 'blacklist_device', 'blacklist_ip', 'amount_cap'];

// POST /api/admin/fraud-rules body. `value` is required for every
// blacklist_* type and forbidden for amount_cap; `threshold` is the
// reverse — enforced with .refine below rather than a discriminated
// union, since the error message reads more clearly to an admin filling
// out a form than a union's generic "invalid input" would.
const fraudRuleCreateBody = z.object({
  rule_type: z.enum(FRAUD_RULE_TYPES, { errorMap: () => ({ message: `rule_type must be one of: ${FRAUD_RULE_TYPES.join(', ')}` }) }),
  value: z.string().trim().min(1).max(255).optional(),
  threshold: z.coerce.number().positive().optional(),
  reason: z.string().trim().max(500).optional(),
}).refine(
  (body) => (body.rule_type === 'amount_cap' ? body.threshold !== undefined && body.value === undefined : body.value !== undefined && body.threshold === undefined),
  { message: 'amount_cap rules need "threshold" (and no "value"); blacklist_* rules need "value" (and no "threshold")' }
);

// PATCH /api/admin/fraud-rules/:id body — every field optional (only
// what's being changed), but at least one of them must be present, or
// this would silently be a no-op PATCH that still bumps updated_at.
const fraudRuleUpdateBody = z.object({
  value: z.string().trim().min(1).max(255).optional(),
  threshold: z.coerce.number().positive().optional(),
  enabled: z.boolean().optional(),
  reason: z.string().trim().max(500).optional(),
}).refine((body) => Object.keys(body).length > 0, { message: 'Provide at least one field to update' });

// GET /api/admin/alerts/:id/sar-report query (feature: SAR-style
// exportable reports) — which rendering to return.
const sarReportQuery = z.object({
  format: z.enum(['pdf', 'csv']).default('pdf'),
});

module.exports = {
  updateRoleParams, idParam, updateRoleBody, simulationStart, auditLogQuery, auditLogExportQuery,
  shadowSetBody, fraudRuleCreateBody, fraudRuleUpdateBody, sarReportQuery,
};
