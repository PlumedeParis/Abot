'use strict';

// Storage shared by the Minecraft and Discord bots: SQLite by default,
// PostgreSQL when DATABASE_URL is set. SQL uses "?" placeholders and the
// subset both understand.
//   db.all(sql, params) -> rows     db.get(sql, params) -> row | undefined
//   db.run(sql, params) -> { changes }     db.transaction(async (tx) => ...)
// The tables are the same as in earlier versions, so existing data is kept.

const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS = [
  (id) => [
    'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT, updated_at BIGINT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS runtime_status (key TEXT PRIMARY KEY, value TEXT, updated_at BIGINT NOT NULL)',
    `CREATE TABLE IF NOT EXISTS links (id ${id}, discord_id TEXT NOT NULL, mc_username TEXT NOT NULL, mc_username_lower TEXT NOT NULL,
      mc_uuid TEXT, linked_at BIGINT NOT NULL, last_username_change_at BIGINT, verification_status TEXT NOT NULL,
      revoked_at BIGINT, revoked_reason TEXT)`,
    "CREATE UNIQUE INDEX IF NOT EXISTS links_active_username ON links (mc_username_lower) WHERE verification_status = 'verified'",
    "CREATE UNIQUE INDEX IF NOT EXISTS links_active_uuid ON links (mc_uuid) WHERE verification_status = 'verified' AND mc_uuid IS NOT NULL",
    'CREATE INDEX IF NOT EXISTS links_discord ON links (discord_id)',
    `CREATE TABLE IF NOT EXISTS username_history (id ${id}, discord_id TEXT NOT NULL, link_id BIGINT, action TEXT NOT NULL,
      old_username TEXT, new_username TEXT, old_uuid TEXT, new_uuid TEXT, reason TEXT, created_at BIGINT NOT NULL)`,
    'CREATE INDEX IF NOT EXISTS username_history_discord ON username_history (discord_id, created_at)',
    `CREATE TABLE IF NOT EXISTS link_codes (id ${id}, code_hash TEXT NOT NULL UNIQUE, discord_id TEXT NOT NULL, mc_username TEXT NOT NULL,
      mc_username_lower TEXT NOT NULL, replace_link_id BIGINT, created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, used_at BIGINT)`,
    'CREATE INDEX IF NOT EXISTS link_codes_discord ON link_codes (discord_id)',
    `CREATE TABLE IF NOT EXISTS link_attempts (id ${id}, mc_username_lower TEXT NOT NULL, success INTEGER NOT NULL, created_at BIGINT NOT NULL)`,
    'CREATE INDEX IF NOT EXISTS link_attempts_user ON link_attempts (mc_username_lower, created_at)',
    `CREATE TABLE IF NOT EXISTS requests (id ${id}, discord_id TEXT NOT NULL, mc_username TEXT NOT NULL, mc_username_lower TEXT NOT NULL,
      kit TEXT NOT NULL, status TEXT NOT NULL, stage TEXT, attempts INTEGER NOT NULL DEFAULT 0, created_at BIGINT NOT NULL,
      started_at BIGINT, completed_at BIGINT, error TEXT)`,
    // One pending request per Discord account, enforced by the database.
    "CREATE UNIQUE INDEX IF NOT EXISTS requests_one_pending ON requests (discord_id) WHERE status IN ('queued', 'processing')",
    'CREATE INDEX IF NOT EXISTS requests_discord_created ON requests (discord_id, created_at)',
    'CREATE INDEX IF NOT EXISTS requests_status_created ON requests (status, created_at)',
    'CREATE INDEX IF NOT EXISTS requests_started ON requests (started_at)',
    'CREATE TABLE IF NOT EXISTS limit_resets (discord_id TEXT PRIMARY KEY, cooldown_reset_at BIGINT, quota_reset_at BIGINT)',
    `CREATE TABLE IF NOT EXISTS events (id ${id}, level TEXT NOT NULL, type TEXT NOT NULL, message TEXT NOT NULL, data TEXT,
      created_at BIGINT NOT NULL, sent_at BIGINT, send_attempts INTEGER NOT NULL DEFAULT 0)`,
    'CREATE INDEX IF NOT EXISTS events_unsent ON events (sent_at, id)',
    'CREATE INDEX IF NOT EXISTS events_created ON events (created_at)'
  ],
  (id) => [
    `CREATE TABLE IF NOT EXISTS chat_outbox (id ${id}, message TEXT NOT NULL, requested_by TEXT NOT NULL, created_at BIGINT NOT NULL,
      sent_at BIGINT, error TEXT)`,
    'CREATE INDEX IF NOT EXISTS chat_outbox_pending ON chat_outbox (sent_at, id)'
  ],
  (id) => [
    `CREATE TABLE IF NOT EXISTS bans (id ${id}, mc_username_lower TEXT, mc_username TEXT, discord_id TEXT, reason TEXT,
      banned_by TEXT NOT NULL, created_at BIGINT NOT NULL)`,
    'CREATE INDEX IF NOT EXISTS bans_username ON bans (mc_username_lower)',
    'CREATE INDEX IF NOT EXISTS bans_discord ON bans (discord_id)'
  ]
];

const ID_COLUMN = { sqlite: 'INTEGER PRIMARY KEY AUTOINCREMENT', postgres: 'BIGSERIAL PRIMARY KEY' };

const cleanParams = (params) => (params || []).map((p) => (p === undefined ? null : typeof p === 'boolean' ? Number(p) : p));
const numberRow = (row) => {
  if (row) for (const k of Object.keys(row)) if (typeof row[k] === 'bigint') row[k] = Number(row[k]);
  return row;
};

// better-sqlite3 is synchronous; a queue keeps an async transaction from
// interleaving with other statements.
function createSqlite(file) {
  const Database = require('better-sqlite3');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const conn = new Database(file);
  conn.pragma('journal_mode = WAL');
  conn.pragma('busy_timeout = 5000');
  const statements = new Map();
  let tail = Promise.resolve();
  const serial = (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
  const exec = (sql, params) => {
    let stmt = statements.get(sql);
    if (!stmt) statements.set(sql, (stmt = conn.prepare(sql)));
    if (stmt.reader) return { rows: stmt.all(...cleanParams(params)).map(numberRow), changes: 0 };
    return { rows: [], changes: stmt.run(...cleanParams(params)).changes };
  };
  const direct = {
    all: async (sql, params) => exec(sql, params).rows,
    get: async (sql, params) => exec(sql, params).rows[0],
    run: async (sql, params) => exec(sql, params)
  };
  return {
    dialect: 'sqlite',
    all: (sql, params) => serial(() => direct.all(sql, params)),
    get: (sql, params) => serial(() => direct.get(sql, params)),
    run: (sql, params) => serial(() => direct.run(sql, params)),
    transaction: (fn) =>
      serial(async () => {
        conn.exec('BEGIN IMMEDIATE');
        try {
          const result = await fn(direct);
          conn.exec('COMMIT');
          return result;
        } catch (e) {
          if (conn.inTransaction) conn.exec('ROLLBACK');
          throw e;
        }
      }),
    close: async () => conn.close()
  };
}

// driver: { query(sql, params), withTransaction(fn(query)), close() }
function createPostgres(driver) {
  const wrap = (query) => {
    const run = async (sql, params) => {
      let n = 0;
      const res = await query(sql.replace(/\?/g, () => `$${++n}`), cleanParams(params));
      return { rows: (res.rows || []).map(numberRow), changes: res.rowCount ?? res.affectedRows ?? 0 };
    };
    return { all: async (sql, p) => (await run(sql, p)).rows, get: async (sql, p) => (await run(sql, p)).rows[0], run };
  };
  return {
    dialect: 'postgres',
    ...wrap(driver.query),
    transaction: (fn) => driver.withTransaction((query) => fn(wrap(query))),
    close: () => driver.close()
  };
}

function pgDriver(url) {
  const pg = require('pg');
  pg.types.setTypeParser(20, Number); // BIGINT -> number
  const pool = new pg.Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 10000 });
  pool.on('error', () => {});
  return {
    query: (sql, params) => pool.query(sql, params),
    async withTransaction(fn) {
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

// For tests: PGlite runs the PostgreSQL code path without a server.
function pgliteDriver(pglite) {
  return {
    query: (sql, params) => pglite.query(sql, params),
    withTransaction: (fn) => pglite.transaction((tx) => fn((sql, params) => tx.query(sql, params))),
    close: () => pglite.close()
  };
}

async function migrate(db) {
  await db.run('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)');
  const done = new Set((await db.all('SELECT version FROM schema_migrations')).map((r) => Number(r.version)));
  for (const [i, statements] of MIGRATIONS.entries()) {
    const version = i + 1;
    if (done.has(version)) continue;
    await db.transaction(async (tx) => {
      for (const sql of statements(ID_COLUMN[db.dialect])) await tx.run(sql);
      await tx.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', [version, Date.now()]);
    });
  }
  return db;
}

function openDatabase({ url, sqlitePath }) {
  return migrate(url ? createPostgres(pgDriver(url)) : createSqlite(sqlitePath));
}

// ---- key/value helpers ------------------------------------------------------

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
  const out = {};
  for (const r of await db.all('SELECT key, value, updated_at FROM runtime_status')) out[r.key] = { value: JSON.parse(r.value), updatedAt: Number(r.updated_at) };
  return out;
}

module.exports = { openDatabase, migrate, createSqlite, createPostgres, pgliteDriver, getSetting, setSetting, setStatus, getStatuses };
