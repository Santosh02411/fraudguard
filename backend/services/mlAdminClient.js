/**
 * ML Admin Client
 * =================
 * Thin wrapper around the ML service's model-monitoring endpoints
 * (drift report, shadow/canary deployment) — mirrors models/mlClient.js's
 * pattern (fetch + timeout + typed error) but for the admin-facing
 * model-ops surface rather than the per-transaction scoring path.
 * routes/admin.js proxies through this instead of the frontend calling
 * ml_service directly, so the ML service never needs to be reachable
 * from the browser (same reasoning as every other backend/db access).
 */

const config = require('../config/env');
const { AppError } = require('../middleware/errorHandler');

const ML_SERVICE_URL = config.mlServiceUrl;
const ML_TIMEOUT_MS = config.mlServiceTimeoutMs;

async function callMlService(path, { method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ML_TIMEOUT_MS);
  try {
    const response = await fetch(`${ML_SERVICE_URL}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw AppError.badRequest(data.detail || `ML service returned ${response.status}`, data);
    }
    return data;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw AppError.serviceUnavailable('ML service is unreachable — is ml_service running?');
  } finally {
    clearTimeout(timeout);
  }
}

const getDrift = () => callMlService('/model/drift');
const resetDrift = () => callMlService('/model/drift/reset', { method: 'POST' });
const getShadowStatus = () => callMlService('/model/shadow/status');
const setShadow = (version) => callMlService('/model/shadow/set', { method: 'POST', body: { version } });
const clearShadow = () => callMlService('/model/shadow/clear', { method: 'POST' });
const promoteShadow = () => callMlService('/model/shadow/promote', { method: 'POST' });
const listVersions = () => callMlService('/model/versions');

module.exports = { getDrift, resetDrift, getShadowStatus, setShadow, clearShadow, promoteShadow, listVersions };
