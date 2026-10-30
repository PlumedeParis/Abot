'use strict';

// Logging. Every event is printed and stored in the "events" table, which the
// Discord bot forwards to #kitbot-logs. Secrets are removed from everything.

const LEVELS = { DEBUG: 0, INFO: 1, WARNING: 2, ERROR: 3, ADMIN: 4 };

const PATTERNS = [
  [/[MNO][A-Za-z\d_-]{23,27}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,40}/g, '[REDACTED_TOKEN]'], // Discord tokens
  [/(\w+:\/\/[^:\s/]+:)[^@\s]+@/g, '$1[REDACTED]@'], // credentials in URLs
  [/(\/(?:reg|register|changepassword)\s+)\S+(\s+\S+)?/gi, '$1[REDACTED]'], // AuthMe commands
  [/(\/(?:log|login|l)\s+)\S+/gi, '$1[REDACTED]']
];

function createRedactor(secrets = []) {
  const values = [...new Set(secrets)].sort((a, b) => b.length - a.length);
  return (input) => {
    if (input === null || input === undefined) return input;
    let s = typeof input === 'string' ? input : JSON.stringify(input);
    for (const v of values) s = s.split(v).join('[REDACTED]');
    for (const [re, rep] of PATTERNS) s = s.replace(re, rep);
    return s;
  };
}

// `details` (e.g. coordinates) are stored for Discord but never printed: the
// console of a hosting panel can be seen by others.
function createLogger({ db = null, secrets = [], consoleLevel = 'INFO', out = console } = {}) {
  const redact = createRedactor(secrets);
  const min = LEVELS[consoleLevel] ?? LEVELS.INFO;
  const backlog = [];
  let database = db;

  async function store(evt) {
    if (!database) return void backlog.push(evt);
    try {
      await database.run('INSERT INTO events (level, type, message, data, created_at) VALUES (?, ?, ?, ?, ?)', [evt.level, evt.type, evt.message, null, evt.at]);
    } catch (e) {
      if (backlog.length < 500) backlog.push(evt);
      out.error(`[${new Date().toISOString()}] ERROR   log.store ${redact(e.message)}`);
    }
  }

  function log(level, type, message, details) {
    const text = redact(String(message));
    const evt = { level, type, message: (details ? `${text}\n${redact(String(details))}` : text).slice(0, 3800), at: Date.now() };
    if (LEVELS[level] >= min) {
      const line = `[${new Date(evt.at).toISOString()}] ${level.padEnd(7)} ${type} ${text}${details ? ' (details in Discord)' : ''}`;
      (level === 'ERROR' ? out.error : level === 'WARNING' ? out.warn : out.log).call(out, line);
    }
    return level === 'DEBUG' ? Promise.resolve() : store(evt);
  }

  return {
    redact,
    async setDatabase(d) {
      database = d;
      while (backlog.length) await store(backlog.shift());
    },
    debug: (type, msg) => log('DEBUG', type, msg),
    info: (type, msg, details) => log('INFO', type, msg, details),
    warn: (type, msg, details) => log('WARNING', type, msg, details),
    error: (type, msg, details) => log('ERROR', type, msg, details),
    admin: (type, msg, details) => log('ADMIN', type, msg, details)
  };
}

const placeholders = (ids) => ids.map(() => '?').join(',');

const unsentEvents = (db, limit = 10) => db.all('SELECT * FROM events WHERE sent_at IS NULL AND send_attempts < 20 ORDER BY id LIMIT ?', [limit]);

async function markSent(db, ids) {
  if (ids.length) await db.run(`UPDATE events SET sent_at = ? WHERE id IN (${placeholders(ids)})`, [Date.now(), ...ids]);
}

async function markFailed(db, ids) {
  if (ids.length) await db.run(`UPDATE events SET send_attempts = send_attempts + 1 WHERE id IN (${placeholders(ids)})`, ids);
}

function recentEvents(db, limit = 15, levels = null) {
  if (levels) return db.all(`SELECT * FROM events WHERE level IN (${placeholders(levels)}) ORDER BY id DESC LIMIT ?`, [...levels, limit]);
  return db.all('SELECT * FROM events ORDER BY id DESC LIMIT ?', [limit]);
}

const pruneEvents = (db, days) => db.run('DELETE FROM events WHERE created_at < ? AND (sent_at IS NOT NULL OR send_attempts >= 20)', [Date.now() - days * 86400000]);

module.exports = { LEVELS, createRedactor, createLogger, unsentEvents, markSent, markFailed, recentEvents, pruneEvents };
