/**
 * FraudGuard - Demo Data Seeder
 * ================================
 * Populates the live app database with a large volume of realistic
 * transaction history — replacing "one manual/random-filled transaction
 * at a time" with an actual explorable dataset across many users, so the
 * dashboard, analytics charts, alerts feed, and admin view all have real
 * data to show instead of being empty until someone clicks around by hand.
 *
 * Every seeded transaction is run through the SAME production scoring
 * pipeline used by POST /api/transactions (analyzeTransactionHybrid —
 * hard rules + ML model + rule-engine fallback), just backdated to the
 * transaction's own simulated timestamp instead of "now". So the
 * fraud_score / risk_level / SHAP explanations / alerts you see for
 * seeded data are exactly what the live app would have produced in
 * real time — not separately faked numbers.
 *
 * Works against SQLite (dev default) or Postgres (set DATABASE_URL) —
 * this script only talks to the database through config/database.js and
 * models/*Repository.js, same as the rest of the app.
 *
 * Usage:
 *   node scripts/seedDemoData.js                  # default: 12 users, 60 days
 *   node scripts/seedDemoData.js --users=20 --days=90
 *   node scripts/seedDemoData.js --reset           # wipe previous demo data first
 */

require('../config/env'); // loads + validates .env the same way server.js does
const bcrypt = require('bcryptjs');
const db = require('../config/database');
const { initSchema } = require('../config/schema');
const userRepository = require('../models/userRepository');
const transactionRepository = require('../models/transactionRepository');
const alertRepository = require('../models/alertRepository');
const { analyzeTransactionHybrid } = require('../models/fraudEngine');
const { buildProfile, generateTimeline } = require('./generateDemoTimeline');
const { FIRST_NAMES, LAST_NAMES, pick } = require('./demoVocabulary');

const DEMO_EMAIL_DOMAIN = 'demo.fraudguard.io'; // tags seeded users for --reset

function parseArgs() {
  const args = {};
  for (const arg of process.argv.slice(2)) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    args[key] = value === undefined ? true : value;
  }
  return {
    users: Number(args.users || 12),
    days: Number(args.days || 60),
    txnsPerWeek: Number(args.txnsPerWeek || 9),
    reset: Boolean(args.reset),
  };
}

function makeUsername(used) {
  let username;
  do {
    username = (pick(FIRST_NAMES) + '.' + pick(LAST_NAMES)).toLowerCase();
  } while (used.has(username));
  used.add(username);
  return username;
}

async function resetDemoData() {
  console.log('Resetting previous demo data...');
  const demoUsers = await db.all('SELECT id FROM users WHERE email LIKE ?', [`%@${DEMO_EMAIL_DOMAIN}`]);
  const ids = demoUsers.map((u) => u.id);
  if (ids.length === 0) {
    console.log('  (no previous demo users found)');
    return;
  }
  const placeholders = ids.map(() => '?').join(',');
  await db.run(`DELETE FROM alerts WHERE user_id IN (${placeholders})`, ids);
  await db.run(`DELETE FROM transactions WHERE user_id IN (${placeholders})`, ids);
  await db.run(`DELETE FROM users WHERE id IN (${placeholders})`, ids);
  console.log(`  Removed ${ids.length} demo users and their transactions/alerts.`);
}

async function seedUser(username, days, txnsPerWeek, endTime) {
  const email = `${username}@${DEMO_EMAIL_DOMAIN}`;
  const passwordHash = bcrypt.hashSync('demo1234', 10);
  const user = await userRepository.create({ username, email, passwordHash, role: 'user' });
  const userId = user.id;

  const profile = buildProfile(username);
  // Most users have a completely clean history. Fraud scenarios are
  // bursty by nature (several transactions in minutes), so even one
  // burst noticeably spikes that individual user's fraud fraction —
  // which is realistic (a compromised account shows a concentrated
  // burst against an otherwise clean history). Keeping most users at
  // zero scenarios is what keeps the AGGREGATE rate across all seeded
  // users down near real-world prevalence (~1-3%).
  const scenarioRoll = Math.random();
  const scenarioCount = scenarioRoll < 0.85 ? 0 : scenarioRoll < 0.97 ? 1 : 2;

  const timeline = generateTimeline(profile, days, endTime, txnsPerWeek, scenarioCount);

  const counts = { total: 0, fraud: 0, medium: 0, byMethod: {} };

  for (const spec of timeline) {
    const isoTime = spec.timestamp.toISOString();

    const [recentTxns, blacklist] = await Promise.all([
      transactionRepository.recentForUser(userId, { before: isoTime }),
      transactionRepository.fraudDeviceAndIpBlacklist({ before: isoTime }),
    ]);

    const txnData = {
      amount: spec.amount,
      merchant: spec.merchant,
      category: spec.category,
      location: spec.location,
      card_type: spec.card_type,
      device_fingerprint: spec.device_fingerprint,
      ip_address: spec.ip_address,
    };

    const analysis = await analyzeTransactionHybrid(txnData, recentTxns, blacklist, spec.timestamp);

    const { lastInsertRowid: txnId } = await transactionRepository.insert({
      user_id: userId,
      ...txnData,
      is_fraud: analysis.is_fraud,
      fraud_score: analysis.fraud_score,
      risk_level: analysis.risk_level,
      fraud_reasons: analysis.fraud_reasons,
      scoring_method: analysis.scoring_method,
      model_version: analysis.model_version,
      hard_flag_triggered: analysis.hard_flag_triggered,
      shap_explanation: analysis.shap_explanation,
      status: 'completed',
      created_at: isoTime,
    });

    if (analysis.risk_level === 'high' || analysis.risk_level === 'medium') {
      const riskLabel = analysis.risk_level === 'high' ? 'High risk' : 'Medium risk';
      await alertRepository.insert({
        transaction_id: txnId,
        user_id: userId,
        message: `${riskLabel} transaction detected at ${spec.merchant}. Amount: $${spec.amount.toFixed(2)}`,
        risk_level: analysis.risk_level,
        created_at: isoTime,
      });
    }

    counts.total++;
    if (analysis.is_fraud) counts.fraud++;
    if (analysis.risk_level === 'medium') counts.medium++;
    counts.byMethod[analysis.scoring_method] = (counts.byMethod[analysis.scoring_method] || 0) + 1;
  }

  return { username, scenarioCount, ...counts };
}

async function main({ users, days, txnsPerWeek, reset } = parseArgs()) {
  await initSchema();

  if (reset) await resetDemoData();

  console.log(`Seeding ${users} demo users, ~${days} days of history each (${db.dialect})...\n`);
  const endTime = new Date();
  const used = new Set();
  const summaries = [];

  for (let i = 0; i < users; i++) {
    const username = makeUsername(used);
    process.stdout.write(`  [${i + 1}/${users}] ${username} ... `);
    const t0 = Date.now();
    const summary = await seedUser(username, days, txnsPerWeek, endTime);
    summaries.push(summary);
    console.log(`${summary.total} txns, ${summary.fraud} flagged fraud, ${summary.medium} medium-risk (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }

  const grandTotal = summaries.reduce((a, s) => a + s.total, 0);
  const grandFraud = summaries.reduce((a, s) => a + s.fraud, 0);
  const methodTotals = {};
  for (const s of summaries) {
    for (const [method, count] of Object.entries(s.byMethod)) {
      methodTotals[method] = (methodTotals[method] || 0) + count;
    }
  }

  console.log('\n=== Seed complete ===');
  console.log(`Total transactions: ${grandTotal}`);
  console.log(`Flagged as fraud:   ${grandFraud} (${((grandFraud / grandTotal) * 100).toFixed(2)}%)`);
  console.log('Scoring method breakdown:', methodTotals);
  console.log(`\nDemo users created with password "demo1234" (e.g. ${summaries[0]?.username}@${DEMO_EMAIL_DOMAIN})`);
  console.log('Log in as admin (admin / admin123) to see everything across all users.');

  return { userCount: users, transactionCount: grandTotal, fraudCount: grandFraud };
}

/**
 * Whether demo data has already been seeded — used by server.js's
 * SEED_ON_BOOT check (see below) so a container restart doesn't reseed
 * on every boot, and so `--reset` remains the only way to actually wipe
 * and redo it.
 */
async function hasDemoData() {
  const row = await db.get('SELECT COUNT(*) as count FROM users WHERE email LIKE ?', [`%@${DEMO_EMAIL_DOMAIN}`]);
  return Number(row.count) > 0;
}

/**
 * Callable from server.js's boot sequence (SEED_ON_BOOT=true) as well as
 * from the CLI below. Never throws — a seed failure shouldn't take down
 * the server; the caller decides how loudly to log it. Skips entirely if
 * demo data already exists, so restarting a long-running deployment
 * doesn't keep appending more of it.
 */
async function seedIfEmpty({ users, days, txnsPerWeek = 9 } = {}) {
  await initSchema();
  if (await hasDemoData()) {
    return { seeded: false, reason: 'demo data already present' };
  }
  const result = await main({ users, days, txnsPerWeek, reset: false });
  return { seeded: true, ...result };
}

module.exports = { main, seedIfEmpty, hasDemoData };

// CLI entrypoint — only runs the process-level bits (db.close/exit) when
// this file is executed directly (`node scripts/seedDemoData.js`), not
// when it's require()'d by server.js for SEED_ON_BOOT.
if (require.main === module) {
  main()
    .then(() => db.close())
    .catch((err) => {
      console.error('Seeding failed:', err);
      process.exit(1);
    });
}
