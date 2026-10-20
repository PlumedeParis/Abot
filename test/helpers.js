'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createSqliteAdapter, createPostgresAdapter, pgliteDriver, migrate } = require('../src/database');
const { DEFAULTS, deepMerge } = require('../src/config');

const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;
const ADMIN_ID = '111111111111111111';
const GUILD_ID = '222222222222222222';

// Fully-filled settings based on config.example.json (test coordinates only).
function testSettings(overrides = {}) {
  const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.example.json'), 'utf8'));
  const s = deepMerge(DEFAULTS, example);
  s.server.botsAllowedConfirmed = true;
  s.navigation.home = { x: 0, y: 64, z: 0, facing: 'north' };
  s.delivery.dropoff = { x: 0, y: 64, z: 5 };
  // One block past each kit's stand position (home facing north: totem west, pvp east, grief south).
  s.kits.totem.retrieval.container = { x: -4, y: 64, z: 0 };
  s.kits.pvp.retrieval.container = { x: 4, y: 64, z: 0 };
  s.kits.grief.retrieval.container = { x: 0, y: 64, z: 4 };
  return deepMerge(s, overrides);
}

async function sqliteDb() {
  const db = createSqliteAdapter(':memory:');
  await migrate(db);
  return db;
}

async function pgliteDb() {
  const { PGlite } = require('@electric-sql/pglite');
  const db = createPostgresAdapter(pgliteDriver(new PGlite()));
  await migrate(db);
  return db;
}

const BACKENDS = [
  ['sqlite', sqliteDb],
  ['postgres (pglite)', pgliteDb]
];

function fakeLogger() {
  const events = [];
  const rec = (level) => async (type, message) => {
    events.push({ level, type, message });
  };
  return {
    events,
    redact: (s) => s,
    debug: rec('DEBUG'),
    info: rec('INFO'),
    warn: rec('WARNING'),
    error: rec('ERROR'),
    admin: rec('ADMIN'),
    has: (type) => events.some((e) => e.type === type)
  };
}

const member = async () => ({ status: 'member' });

module.exports = { MIN, HOUR, DAY, ADMIN_ID, GUILD_ID, testSettings, sqliteDb, pgliteDb, BACKENDS, fakeLogger, member };
