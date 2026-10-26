'use strict';

const { createSqlite, createPostgres, pgliteDriver, migrate } = require('../src/db');
const { DEFAULTS, deepMerge } = require('../src/config');

const settings = (overrides = {}) => deepMerge(structuredClone(DEFAULTS), overrides);

const sqliteDb = () => migrate(createSqlite(':memory:'));

async function pgliteDb() {
  const { PGlite } = require('@electric-sql/pglite');
  return migrate(createPostgres(pgliteDriver(new PGlite())));
}

function fakeLogger() {
  const events = [];
  const at = (level) => async (type, message) => void events.push({ level, type, message: String(message) });
  return { events, redact: (s) => s, debug: at('DEBUG'), info: at('INFO'), warn: at('WARNING'), error: at('ERROR'), admin: at('ADMIN') };
}

const member = async () => ({ status: 'member' });

const waitFor = async (test, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await test()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

module.exports = { settings, sqliteDb, pgliteDb, fakeLogger, member, waitFor };
