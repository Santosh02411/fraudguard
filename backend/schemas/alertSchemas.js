const { z } = require('zod');

const resolveParams = z.object({
  id: z.coerce.number().int().positive(),
});

// PATCH /:id/resolve body — verdict is required, not optional: the whole
// point of this endpoint is to record an analyst's confirmed/false-positive
// call, not just flip a boolean. `confirmed_fraud` is what feeds the
// dynamic device/IP blacklist (see transactionRepository.fraudDeviceAndIpBlacklist)
// and would feed model retraining in a real system — `false_positive`
// explicitly removes that transaction from the blacklist signal even if
// the model originally scored it as fraud, closing the feedback loop the
// old resolve-as-boolean version couldn't.
const resolveBody = z.object({
  verdict: z.enum(['confirmed_fraud', 'false_positive'], {
    errorMap: () => ({ message: 'verdict must be "confirmed_fraud" or "false_positive"' }),
  }),
  note: z.string().trim().max(1000, 'Note must be 1000 characters or fewer').optional(),
});

// PATCH /:id/assign body — assigneeId is nullable to support unassigning.
const assignBody = z.object({
  assigneeId: z.number().int().positive().nullable(),
});

// PATCH /bulk-resolve body — same verdict/note shape as a single
// resolve, applied to a batch of alert ids in one request (feature:
// bulk actions). Capped at 100 per call: large enough for a real
// triage sweep, small enough that one request can't tie up the DB or
// blow past a reasonable request-body size.
const bulkResolveBody = z.object({
  alertIds: z.array(z.number().int().positive()).min(1, 'at least one alertId is required').max(100, 'at most 100 alertIds per request'),
  verdict: z.enum(['confirmed_fraud', 'false_positive'], {
    errorMap: () => ({ message: 'verdict must be "confirmed_fraud" or "false_positive"' }),
  }),
  note: z.string().trim().max(1000, 'Note must be 1000 characters or fewer').optional(),
});

const ALERT_STATUSES = ['open', 'in_review', 'resolved'];
const ALERT_RISK_LEVELS = ['medium', 'high'];

// GET / query filters, layered on top of the shared pagination schema
// (see routes/alerts.js) — every field optional, so existing callers that
// only send page/limit keep working unchanged.
const listQuery = z.object({
  status: z.enum(ALERT_STATUSES).optional(),
  riskLevel: z.enum(ALERT_RISK_LEVELS).optional(),
  merchant: z.string().trim().min(1).max(100).optional(),
  dateFrom: z.string().datetime({ offset: true }).or(z.string().date()).optional(),
  dateTo: z.string().datetime({ offset: true }).or(z.string().date()).optional(),
  amountMin: z.coerce.number().nonnegative().optional(),
  amountMax: z.coerce.number().nonnegative().optional(),
  assignedTo: z.coerce.number().int().positive().optional(),
});

module.exports = { resolveParams, resolveBody, assignBody, bulkResolveBody, listQuery, ALERT_STATUSES, ALERT_RISK_LEVELS };
