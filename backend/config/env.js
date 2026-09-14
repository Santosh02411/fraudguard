/**
 * Environment-based configuration.
 * ====================================
 * The single place that reads process.env. Every other module imports
 * the parsed `config` object from here instead of touching
 * `process.env` directly — that's what makes it possible to validate
 * everything once, at startup, and fail fast with a clear error instead
 * of discovering a missing/malformed var halfway through a request in
 * production.
 *
 * NODE_ENV drives environment-specific behavior:
 *   - development — verbose (debug) logs, SQLite is fine, a default
 *     admin password is allowed so `npm start` works with zero config.
 *   - staging / production — stricter: DATABASE_URL is required (no
 *     SQLite — see README's "SQLite vs PostgreSQL"), JWT_SECRET must be
 *     reasonably long, and there's no fallback admin password — you
 *     must set one explicitly or the app simply won't create a default
 *     admin account, rather than shipping a known-weak credential.
 *
 * `.env` is never committed (see .gitignore) — copy `.env.example` to
 * `.env` for local dev; staging/production supply real values through
 * the deploy platform's secret manager (Render/Railway/ECS/etc), not a
 * checked-in file.
 */

require('dotenv').config();
const { z } = require('zod');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'staging', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),
  JWT_SECRET: z.string().min(1, 'JWT_SECRET is required'),
  JWT_ACCESS_EXPIRES_IN: z.string().min(1).default('15m'),
  REFRESH_TOKEN_EXPIRES_DAYS: z.coerce.number().int().positive().default(30),
  DATABASE_URL: z.string().min(1).optional(),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  ML_SERVICE_URL: z.string().min(1).default('http://localhost:8001'),
  ML_SERVICE_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'http', 'debug']).optional(),
  ADMIN_PASSWORD: z.string().min(1).optional(),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_AUTH_WINDOW_MIN: z.coerce.number().int().positive().default(15),
  RATE_LIMIT_TRANSACTIONS_MAX: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_TRANSACTIONS_WINDOW_MIN: z.coerce.number().int().positive().default(1),
  // Account lockout (see routes/auth.js, models/userRepository.js)
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),
  // Account & auth: email verification, password reset, MFA (see
  // routes/auth.js, services/emailService.js). FRONTEND_URL is used to
  // build the links inside verification/reset emails — must match
  // wherever the React app is actually served.
  FRONTEND_URL: z.string().min(1).default('http://localhost:3000'),
  EMAIL_VERIFICATION_EXPIRES_HOURS: z.coerce.number().int().positive().default(24),
  PASSWORD_RESET_EXPIRES_MINUTES: z.coerce.number().int().positive().default(30),
  MFA_CHALLENGE_EXPIRES_MINUTES: z.coerce.number().int().positive().default(5),
  // Idempotency keys on POST /transactions (see middleware/idempotency.js)
  IDEMPOTENCY_KEY_TTL_HOURS: z.coerce.number().int().positive().default(24),
  // Outbound webhooks (see services/webhookService.js)
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  WEBHOOK_MAX_RETRIES: z.coerce.number().int().positive().default(3),
  // Persistent webhook retry queue (see services/webhookRetryWorker.js)
  WEBHOOK_RETRY_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
  // API keys: default expiration when the caller doesn't specify one
  // (see routes/apiKeys.js) — 0 means "no expiration by default."
  API_KEY_DEFAULT_EXPIRES_DAYS: z.coerce.number().int().nonnegative().default(0),
  // SMTP is optional — see services/emailService.js. With none of these
  // set, emails are logged instead of sent, which is exactly right for
  // local dev (the verification/reset link shows up in the server
  // console) but must be set in staging/production (enforced below).
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().min(1).default('FraudGuard <no-reply@fraudguard.local>'),
  // Comma-separated list of exact origins the API/Socket.io will accept
  // CORS/socket requests from. No wildcard — see the hardening check
  // below for why staging/production must set this explicitly.
  CORS_ALLOWED_ORIGINS: z.string().optional(),
  // Auto-seed demo data on boot if the DB has no demo users yet — for a
  // fresh deploy (Render/Railway/Docker) to show up with realistic data
  // instead of an empty dashboard. See scripts/seedDemoData.js.
  SEED_ON_BOOT: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  SEED_ON_BOOT_USERS: z.coerce.number().int().positive().default(12),
  SEED_ON_BOOT_DAYS: z.coerce.number().int().positive().default(45),
  // Plain-language explanations (see services/explanationService.js).
  // Fully optional: with no key set, the service falls back to a
  // deterministic template-based explanation (same "degrade gracefully"
  // philosophy as ML_SERVICE_URL being unreachable falling back to the
  // rule engine — see fraudEngine.js's header comment). Never required
  // for the app to run.
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().min(1).default('claude-3-5-haiku-20241022'),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(4000),
  // Step-up auth hook (feature: step-up authentication) — how long a
  // merchant has to resolve an OTP/3DS challenge before it expires.
  STEP_UP_CHALLENGE_TTL_MS: z.coerce.number().int().positive().default(5 * 60 * 1000),
});

function fail(lines) {
  console.error('❌ Invalid environment configuration:');
  for (const line of lines) console.error(`   - ${line}`);
  process.exit(1);
}

let parsed;
try {
  parsed = envSchema.parse(process.env);
} catch (err) {
  fail(err.issues ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) : [String(err)]);
}

const env = parsed.NODE_ENV;
const isDev = env === 'development';
const isStaging = env === 'staging';
const isProd = env === 'production';
const isTest = env === 'test';

// Hardening checks that go beyond basic type validation — only enforced
// outside development, so local/demo setup stays zero-friction.
if (isStaging || isProd) {
  const problems = [];
  if (parsed.JWT_SECRET.length < 32) {
    problems.push('JWT_SECRET must be at least 32 characters in staging/production');
  }
  if (!parsed.DATABASE_URL) {
    problems.push('DATABASE_URL must be set in staging/production — SQLite is dev-only (see README)');
  }
  if (!parsed.CORS_ALLOWED_ORIGINS || !parsed.CORS_ALLOWED_ORIGINS.trim()) {
    problems.push("CORS_ALLOWED_ORIGINS must be set in staging/production — no wildcard origin outside development (see README's Security section)");
  }
  if (!parsed.SMTP_HOST) {
    problems.push('SMTP_HOST must be set in staging/production — without it, password-reset and verification emails are only logged to the console, never actually delivered (see services/emailService.js)');
  }
  if (problems.length) fail(problems);
}

const defaultLogLevel = isProd ? 'info' : isTest ? 'error' : 'debug';

// Dev/test get a single localhost origin for free (matches the CRA dev
// server default port) so `npm start` on both sides just works with zero
// config; staging/production must set CORS_ALLOWED_ORIGINS explicitly
// (enforced above) — there is deliberately no wildcard fallback there.
const corsAllowedOrigins = (parsed.CORS_ALLOWED_ORIGINS || (isDev || isTest ? 'http://localhost:3000' : ''))
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

module.exports = {
  env,
  isDev,
  isStaging,
  isProd,
  isTest,
  port: parsed.PORT,
  jwtSecret: parsed.JWT_SECRET,
  jwtAccessExpiresIn: parsed.JWT_ACCESS_EXPIRES_IN,
  refreshTokenExpiresDays: parsed.REFRESH_TOKEN_EXPIRES_DAYS,
  databaseUrl: parsed.DATABASE_URL,
  dbPoolMax: parsed.DB_POOL_MAX,
  mlServiceUrl: parsed.ML_SERVICE_URL,
  mlServiceTimeoutMs: parsed.ML_SERVICE_TIMEOUT_MS,
  logLevel: parsed.LOG_LEVEL || defaultLogLevel,
  // No fallback outside dev/test — an unset ADMIN_PASSWORD in
  // staging/production means "don't auto-create a default admin",
  // not "use a known weak one." See config/schema.js.
  adminPassword: parsed.ADMIN_PASSWORD || (isDev || isTest ? 'admin123' : null),
  rateLimit: {
    authMax: parsed.RATE_LIMIT_AUTH_MAX,
    authWindowMin: parsed.RATE_LIMIT_AUTH_WINDOW_MIN,
    transactionsMax: parsed.RATE_LIMIT_TRANSACTIONS_MAX,
    transactionsWindowMin: parsed.RATE_LIMIT_TRANSACTIONS_WINDOW_MIN,
  },
  loginLockout: {
    maxAttempts: parsed.LOGIN_MAX_ATTEMPTS,
    lockoutMinutes: parsed.LOGIN_LOCKOUT_MINUTES,
  },
  corsAllowedOrigins,
  seedOnBoot: parsed.SEED_ON_BOOT,
  seedOnBootUsers: parsed.SEED_ON_BOOT_USERS,
  seedOnBootDays: parsed.SEED_ON_BOOT_DAYS,
  frontendUrl: parsed.FRONTEND_URL,
  emailVerificationExpiresHours: parsed.EMAIL_VERIFICATION_EXPIRES_HOURS,
  passwordResetExpiresMinutes: parsed.PASSWORD_RESET_EXPIRES_MINUTES,
  mfaChallengeExpiresMinutes: parsed.MFA_CHALLENGE_EXPIRES_MINUTES,
  idempotencyKeyTtlHours: parsed.IDEMPOTENCY_KEY_TTL_HOURS,
  webhookTimeoutMs: parsed.WEBHOOK_TIMEOUT_MS,
  webhookMaxRetries: parsed.WEBHOOK_MAX_RETRIES,
  webhookRetrySweepIntervalMs: parsed.WEBHOOK_RETRY_SWEEP_INTERVAL_MS,
  apiKeyDefaultExpiresDays: parsed.API_KEY_DEFAULT_EXPIRES_DAYS,
  smtp: {
    host: parsed.SMTP_HOST || null,
    port: parsed.SMTP_PORT,
    secure: parsed.SMTP_SECURE,
    user: parsed.SMTP_USER || null,
    pass: parsed.SMTP_PASS || null,
    from: parsed.SMTP_FROM,
  },
  anthropicApiKey: parsed.ANTHROPIC_API_KEY || null,
  anthropicModel: parsed.ANTHROPIC_MODEL,
  llmTimeoutMs: parsed.LLM_TIMEOUT_MS,
  stepUpChallengeTtlMs: parsed.STEP_UP_CHALLENGE_TTL_MS,
};
