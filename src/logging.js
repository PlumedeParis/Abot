'use strict';

// Structured logging with secret redaction.
// Every event goes to the console and is written to the "events" table, which
// acts as an outbox: the Discord bot forwards unsent rows to the log channel
// and marks them sent, so events survive Discord outages and restarts.

const LEVELS = { DEBUG: 0, INFO: 1, WARNING: 2, ERROR: 3, ADMIN: 4 };

const GENERIC_PATTERNS = [
  // Discord bot tokens
  [/[MNO][A-Za-z\d_-]{23,27}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,40}/g, '[REDACTED_TOKEN]'],
  // Credentials inside connection strings
  [/(\w+:\/\/[^:\s/]+:)[^@\s]+@/g, '$1[REDACTED]@'],
  // AuthMe-style login/register commands
  [/(\/(?:log|login|l|reg|register|changepassword)\s+)\S+(\s+\S+)?/gi, '$1[REDACTED]'],
  [/("?(?:password|token|secret)"?\s*[:=]\s*)"?[^",\s}]+"?/gi, '$1[REDACTED]']
];

function createRedactor(secretValues = []) {
  const values = [...new Set(secretValues)].sort((a, b) => b.length - a.length);
  return function redact(input) {
    if (input === null || input === undefined) return input;
    let s = typeof input === 'string' ? input : JSON.stringify(input);
    for (const v of values) s = s.split(v).join('[REDACTED]');
    for (const [re, rep] of GENERIC_PATTERNS) s = s.replace(re, rep);
    return s;
  };
}

function errorInfo(err) {
  if (!err) return undefined;
  if (err instanceof Error) return { name: err.name, message: err.message, code: err.code };
  return { message: String(err) };
}

function createLogger({ db = null, secretValues = [], consoleLevel = 'INFO', source = 'kitbot', out = console } = {}) {
  const redact = createRedactor(secretValues);
  const minConsole = LEVELS[consoleLevel] ?? LEVELS.INFO;
  const pending = []; // events not yet persisted (database unavailable)
  let database = db;

  async function persist(evt) {
    if (!database) {
      pending.push(evt);
      return;
    }
    try {
      await database.run('INSERT INTO events (level, type, message, data, created_at) VALUES (?, ?, ?, ?, ?)', [
        evt.level,
        evt.type,
        evt.message,
        evt.data,
        evt.createdAt
      ]);
    } catch (e) {
      if (pending.length < 1000) pending.push(evt);
      out.error(`[${new Date().toISOString()}] ERROR logging.persist ${redact(e.message)}`);
    }
  }

  async function flushPending() {
    if (!database) return;
    while (pending.length) {
      const evt = pending.shift();
      try {
        await database.run('INSERT INTO events (level, type, message, data, created_at) VALUES (?, ?, ?, ?, ?)', [
          evt.level,
          evt.type,
          evt.message,
          evt.data,
          evt.createdAt
        ]);
      } catch {
        pending.unshift(evt);
        return;
      }
    }
  }

  function log(level, type, message, data) {
    const evt = {
      level,
      type,
      message: redact(String(message)).slice(0, 1800),
      data: data === undefined ? null : redact(JSON.stringify(data, (k, v) => (v instanceof Error ? errorInfo(v) : v))).slice(0, 3000),
      createdAt: Date.now()
    };
    if (LEVELS[level] >= minConsole) {
      const line = `[${new Date(evt.createdAt).toISOString()}] ${level.padEnd(7)} ${source}:${type} ${evt.message}${evt.data ? ` ${evt.data}` : ''}`;
      (level === 'ERROR' ? out.error : level === 'WARNING' ? out.warn : out.log).call(out, line);
    }
    if (level === 'DEBUG') return Promise.resolve();
    return persist(evt);
  }

  return {
    redact,
    setDatabase(d) {
      database = d;
      return flushPending();
    },
    flushPending,
    debug: (type, msg, data) => log('DEBUG', type, msg, data),
    info: (type, msg, data) => log('INFO', type, msg, data),
    warn: (type, msg, data) => log('WARNING', type, msg, data),
    error: (type, msg, data) => log('ERROR', type, msg, data),
    admin: (type, msg, data) => log('ADMIN', type, msg, data),
    child(childSource) {
      return createLogger({ db: database, secretValues, consoleLevel, source: childSource, out });
    }
  };
}

async function fetchUnsentEvents(db, limit = 10) {
  return db.all('SELECT * FROM events WHERE sent_at IS NULL AND send_attempts < 20 ORDER BY id LIMIT ?', [limit]);
}

async function markEventsSent(db, ids) {
  if (!ids.length) return;
  await db.run(`UPDATE events SET sent_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`, [Date.now(), ...ids]);
}

async function markEventsFailed(db, ids) {
  if (!ids.length) return;
  await db.run(`UPDATE events SET send_attempts = send_attempts + 1 WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
}

async function recentEvents(db, limit = 15, levels = null) {
  if (levels && levels.length) {
    return db.all(`SELECT * FROM events WHERE level IN (${levels.map(() => '?').join(',')}) ORDER BY id DESC LIMIT ?`, [...levels, limit]);
  }
  return db.all('SELECT * FROM events ORDER BY id DESC LIMIT ?', [limit]);
}

async function pruneEvents(db, retentionDays) {
  const cutoff = Date.now() - retentionDays * 86400000;
  await db.run('DELETE FROM events WHERE created_at < ? AND (sent_at IS NOT NULL OR send_attempts >= 20)', [cutoff]);
}

module.exports = {
  LEVELS,
  createLogger,
  createRedactor,
  errorInfo,
  fetchUnsentEvents,
  markEventsSent,
  markEventsFailed,
  recentEvents,
  pruneEvents
};
