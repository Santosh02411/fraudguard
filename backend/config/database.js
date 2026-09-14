/**
 * Database connection abstraction — SQLite (dev) or PostgreSQL (production).
 * ==============================================================================
 * WHY SQLITE IS THE DEV DEFAULT, NOT WHAT SHIPS TO PRODUCTION:
 *
 *   - Single-file, zero-setup: `npm install && npm start` just works, no
 *     separate DB server to install/configure — ideal for local dev and
 *     for anyone cloning this repo to try it out.
 *   - SQLite writes lock the whole database file. Fine for one developer
 *     hitting the API from a browser; wrong for a real deployment with
 *     concurrent users, where a fraud-scoring write on one request
 *     shouldn't block reads from every other request.
 *   - No connection pooling, no replication, no built-in support for the
 *     managed hosting most teams actually deploy to (RDS, Cloud SQL,
 *     Render/Railway Postgres, etc).
 *   - No native DECIMAL type for money — this schema uses REAL/FLOAT for
 *     amounts, which is fine for a demo but not for real financial
 *     reconciliation (Postgres NUMERIC would be the production choice).
 *
 * WHY POSTGRES FOR PRODUCTION:
 *
 *   - Row-level locking and MVCC — concurrent fraud-scoring writes don't
 *     block each other or block reads.
 *   - Connection pooling (via `pg.Pool`) for a multi-instance deployment.
 *   - Real hosted options with backups/replicas/monitoring out of the box.
 *
 * HOW THIS MODULE WORKS:
 *
 * Set DATABASE_URL (a standard postgres:// connection string) to switch
 * to Postgres. Leave it unset and the app runs on a local SQLite file —
 * no code changes required either way. Every query in this codebase is
 * written once, with `?` placeholders (SQLite's native style), and this
 * module transparently renumbers them to `$1, $2, ...` when running
 * against Postgres. The repositories in models/*.js never touch a
 * driver-specific API directly — they only call all()/get()/run()/insert()
 * from this module, so the dialect is switched in exactly one place.
 */

const path = require('path');
const config = require('./env');
const logger = require('./logger');

const IS_POSTGRES = Boolean(config.databaseUrl);

/** Renumbers `?` placeholders to Postgres's `$1, $2, ...` style. */
function toPgPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

let impl;

if (IS_POSTGRES) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    idleTimeoutMillis: 30000,
  });

  pool.on('error', (err) => {
    // A background/idle client failing is not a request-scoped error —
    // log it rather than crashing the process.
    logger.error('Unexpected error on idle Postgres client', { error: err.message });
  });

  impl = {
    dialect: 'postgres',

    async all(sql, params = []) {
      const { rows } = await pool.query(toPgPlaceholders(sql), params);
      return rows;
    },

    async get(sql, params = []) {
      const { rows } = await pool.query(toPgPlaceholders(sql), params);
      return rows[0] || null;
    },

    async run(sql, params = []) {
      const { rowCount } = await pool.query(toPgPlaceholders(sql), params);
      return { changes: rowCount };
    },

    /** INSERT that returns the new row's id, regardless of dialect. */
    async insert(sql, params = []) {
      const withReturning = /returning/i.test(sql) ? sql : `${sql} RETURNING id`;
      const { rows } = await pool.query(toPgPlaceholders(withReturning), params);
      return { lastInsertRowid: rows[0].id };
    },

    async exec(sql) {
      await pool.query(sql);
    },

    async close() {
      await pool.end();
    },
  };
} else {
  const Database = require('better-sqlite3');
  const DB_PATH = process.env.SQLITE_PATH || path.join(__dirname, '..', 'fraudguard.db');
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  impl = {
    dialect: 'sqlite',

    async all(sql, params = []) {
      return db.prepare(sql).all(...params);
    },

    async get(sql, params = []) {
      return db.prepare(sql).get(...params) || null;
    },

    async run(sql, params = []) {
      const info = db.prepare(sql).run(...params);
      return { changes: info.changes };
    },

    async insert(sql, params = []) {
      const info = db.prepare(sql).run(...params);
      return { lastInsertRowid: info.lastInsertRowid };
    },

    async exec(sql) {
      db.exec(sql);
    },

    async close() {
      db.close();
    },
  };
}

module.exports = impl;
