'use strict';

// Persistent storage. Two interchangeable backends behind one small API:
//   - SQLite (better-sqlite3) for local runs and permanent hosts with a disk.
//   - PostgreSQL (pg) when DATABASE_URL is set. Required on GitHub-hosted
//     runners, whose disks are wiped after every job.
// SQL is written in the common subset of both dialects with "?" placeholders.
//
// API: db.all(sql, params) -> rows, db.get(sql, params) -> row|undefined,
//      db.run(sql, params) -> { changes, rows }, db.transaction(async (tx) => ...)

const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS = [
  {
    version: 1,
    statements: (d) => [
      `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at BIGINT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS runtime_status (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at BIGINT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS links (
        id ${d.id},
        discord_id TEXT NOT NULL,
        mc_username TEXT NOT NULL,
        mc_username_lower TEXT NOT NULL,
        mc_uuid TEXT,
        linked_at BIGINT NOT NULL,
        last_username_change_at BIGINT,
        verification_status TEXT NOT NULL,
        revoked_at BIGINT,
        revoked_reason TEXT
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS links_active_username
        ON links (mc_username_lower) WHERE verification_status = 'verified'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS links_active_uuid
        ON links (mc_uuid) WHERE verification_status = 'verified' AND mc_uuid IS NOT NULL`,
      'CREATE INDEX IF NOT EXISTS links_discord ON links (discord_id)',
      `CREATE TABLE IF NOT EXISTS username_history (
        id ${d.id},
        discord_id TEXT NOT NULL,
        link_id BIGINT,
        action TEXT NOT NULL,
        old_username TEXT,
        new_username TEXT,
        old_uuid TEXT,
        new_uuid TEXT,
        reason TEXT,
        created_at BIGINT NOT NULL
      )`,
      'CREATE INDEX IF NOT EXISTS username_history_discord ON username_history (discord_id, created_at)',
      `CREATE TABLE IF NOT EXISTS link_codes (
        id ${d.id},
        code_hash TEXT NOT NULL UNIQUE,
        discord_id TEXT NOT NULL,
        mc_username TEXT NOT NULL,
        mc_username_lower TEXT NOT NULL,
        replace_link_id BIGINT,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        used_at BIGINT
      )`,
      'CREATE INDEX IF NOT EXISTS link_codes_discord ON link_codes (discord_id)',
      `CREATE TABLE IF NOT EXISTS link_attempts (
        id ${d.id},
        mc_username_lower TEXT NOT NULL,
        success INTEGER NOT NULL,
        created_at BIGINT NOT NULL
      )`,
      'CREATE INDEX IF NOT EXISTS link_attempts_user ON link_attempts (mc_username_lower, created_at)',
      `CREATE TABLE IF NOT EXISTS requests (
        id ${d.id},
        discord_id TEXT NOT NULL,
        mc_username TEXT NOT NULL,
        mc_username_lower TEXT NOT NULL,
        kit TEXT NOT NULL,
        status TEXT NOT NULL,
        stage TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL,
        started_at BIGINT,
        completed_at BIGINT,
        error TEXT
      )`,
      // Database-level guarantee: one pending request per Discord account.
      `CREATE UNIQUE INDEX IF NOT EXISTS requests_one_pending
        ON requests (discord_id) WHERE status IN ('queued', 'processing')`,
      'CREATE INDEX IF NOT EXISTS requests_discord_created ON requests (discord_id, created_at)',
      'CREATE INDEX IF NOT EXISTS requests_status_created ON requests (status, created_at)',
      'CREATE INDEX IF NOT EXISTS requests_started ON requests (started_at)',
      `CREATE TABLE IF NOT EXISTS limit_resets (
        discord_id TEXT PRIMARY KEY,
        cooldown_reset_at BIGINT,
        quota_reset_at BIGINT
      )`,
      `CREATE TABLE IF NOT EXISTS events (
        id ${d.id},
        level TEXT NOT NULL,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        data TEXT,
        created_at BIGINT NOT NULL,
        sent_at BIGINT,
        send_attempts INTEGER NOT NULL DEFAULT 0
      )`,
      'CREATE INDEX IF NOT EXISTS events_unsent ON events (sent_at, id)',
      'CREATE INDEX IF NOT EXISTS events_created ON events (created_at)'
    ]
  }
];

const DIALECTS = {
  sqlite: { id: 'INTEGER PRIMARY KEY AUTOINCREMENT' },
  postgres: { id: 'BIGSERIAL PRIMARY KEY' }
};

function cleanParams(params) {
  return (params || []).map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
}

function toPgPlaceholders(sql) {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

// Minimal promise-based mutex used to serialise SQLite access so that an
// async transaction never interleaves with unrelated statements.
function createMutex() {
  let tail = Promise.resolve();
  return function lock(fn) {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

function normaliseRow(row) {
  if (!row) return row;
  for (const k of Object.keys(row)) if (typeof row[k] === 'bigint') row[k] = Number(row[k]);
  return row;
}

function createSqliteAdapter(file) {
  const Database = require('better-sqlite3');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const conn = new Database(file);
  conn.pragma('journal_mode = WAL');
  conn.pragma('busy_timeout = 5000');
  const lock = createMutex();
  const cache = new Map();

  const exec = (sql, params) => {
    let stmt = cache.get(sql);
    if (!stmt) {
      stmt = conn.prepare(sql);
      cache.set(sql, stmt);
    }
    const p = cleanParams(params);
    if (stmt.reader) {
      const rows = stmt.all(...p).map(normaliseRow);
      return { rows, changes: rows.length };
    }
    const info = stmt.run(...p);
    return { rows: [], changes: info.changes };
  };

  const direct = {
    all: async (sql, params) => exec(sql, params).rows,
    get: async (sql, params) => exec(sql, params).rows[0],
    run: async (sql, params) => exec(sql, params)
  };

  return {
    dialect: 'sqlite',
    all: (sql, params) => lock(() => direct.all(sql, params)),
    get: (sql, params) => lock(() => direct.get(sql, params)),
    run: (sql, params) => lock(() => direct.run(sql, params)),
    transaction: (fn) =>
      lock(async () => {
        conn.prepare('BEGIN IMMEDIATE').run();
        try {
          const result = await fn(direct);
          conn.prepare('COMMIT').run();
          return result;
        } catch (e) {
          if (conn.inTransaction) conn.prepare('ROLLBACK').run();
          throw e;
        }
      }),
    exec: (sql) => lock(async () => conn.exec(sql)),
    close: async () => conn.close()
  };
}

// driver: { query(sql, params) -> { rows, rowCount }, withTransaction(fn(queryFn)), close() }
function createPostgresAdapter(driver) {
  const wrap = (query) => {
    const q = async (sql, params) => {
      const res = await query(toPgPlaceholders(sql), cleanParams(params));
      return { rows: (res.rows || []).map(normaliseRow), changes: res.rowCount ?? res.affectedRows ?? 0 };
    };
    return {
      all: async (sql, params) => (await q(sql, params)).rows,
      get: async (sql, params) => (await q(sql, params)).rows[0],
      run: q
    };
  };
  const base = wrap(driver.query);
  return {
    dialect: 'postgres',
    ...base,
    transaction: (fn) => driver.withTransaction((query) => fn(wrap(query))),
    exec: async (sql) => driver.query(sql, []),
    close: () => driver.close()
  };
}

function nodePgDriver(url) {
  const pg = require('pg');
  pg.types.setTypeParser(20, (v) => Number(v)); // BIGINT -> number (epoch ms fit safely)
  // TLS is controlled by the connection string (e.g. "?sslmode=require"), with
  // certificate verification left on.
  const pool = new pg.Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 10000 });
  pool.on('error', () => {}); // idle client errors are surfaced on the next query
  return {
    query: (sql, params) => pool.query(sql, params),
    withTransaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn((sql, params) => client.query(sql, params));
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end()
  };
}

// Used by the test-suite to run the PostgreSQL code path without a server.
function pgliteDriver(pglite) {
  return {
    query: (sql, params) => pglite.query(sql, params),
    withTransaction: (fn) => pglite.transaction((tx) => fn((sql, params) => tx.query(sql, params))),
    close: () => pglite.close()
  };
}

async function migrate(db) {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)');
  const applied = new Set((await db.all('SELECT version FROM schema_migrations')).map((r) => Number(r.version)));
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    await db.transaction(async (tx) => {
      for (const stmt of m.statements(DIALECTS[db.dialect])) await tx.run(stmt);
      await tx.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', [m.version, Date.now()]);
    });
  }
}

async function openDatabase(dbConfig) {
  const db = dbConfig.url ? createPostgresAdapter(nodePgDriver(dbConfig.url)) : createSqliteAdapter(dbConfig.sqlitePath);
  await migrate(db);
  return db;
}

// ---- small key/value helpers shared by both bots -------------------------

async function getSetting(db, key, fallback = null) {
  const row = await db.get('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? JSON.parse(row.value) : fallback;
}

async function setSetting(db, key, value) {
  await db.run(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    [key, JSON.stringify(value), Date.now()]
  );
}

async function setStatus(db, key, value) {
  await db.run(
    'INSERT INTO runtime_status (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    [key, JSON.stringify(value), Date.now()]
  );
}

async function getStatuses(db) {
  const rows = await db.all('SELECT key, value, updated_at FROM runtime_status');
  const out = {};
  for (const r of rows) out[r.key] = { value: JSON.parse(r.value), updatedAt: Number(r.updated_at) };
  return out;
}

module.exports = {
  openDatabase,
  migrate,
  createSqliteAdapter,
  createPostgresAdapter,
  pgliteDriver,
  toPgPlaceholders,
  getSetting,
  setSetting,
  setStatus,
  getStatuses
};
