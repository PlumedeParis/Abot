'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRedactor, createLogger, fetchUnsentEvents, markEventsSent } = require('../src/logging');
const { loadSettings, loadConfig, validateSettings, secretValues, loadSecrets } = require('../src/config');
const { sanitizeOutgoing, fill } = require('../src/minecraft');
const { sqliteDb, testSettings } = require('./helpers');

const EXAMPLE = path.join(__dirname, '..', 'config.example.json');
// Fake token assembled at runtime so secret scanners do not flag the source.
const FAKE_TOKEN = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GabcDE', 'abcdefghijklmnopqrstuvwxyz0123456789AB'].join('.');

const ENV = {
  KITBOT_CONFIG: EXAMPLE,
  MINECRAFT_HOST: '1b1t.cc',
  MINECRAFT_USERNAME: 'KitBot',
  MINECRAFT_AUTH: 'offline',
  MINECRAFT_PASSWORD: 'Sup3rSecretPw',
  DISCORD_TOKEN: FAKE_TOKEN,
  DISCORD_GUILD_ID: '222222222222222222',
  DISCORD_LOG_CHANNEL_ID: '333333333333333333',
  DISCORD_ADMIN_IDS: '111111111111111111, 444444444444444444',
  DATABASE_URL: 'postgresql://kitbot:dbPassw0rd@db.example.com:5432/kitbot?sslmode=require'
};

test('secrets never appear in logs', () => {
  const redact = createRedactor(secretValues(loadSecrets(ENV)));
  const leaked = `token=${ENV.DISCORD_TOKEN} pw ${ENV.MINECRAFT_PASSWORD} db ${ENV.DATABASE_URL} /log ${ENV.MINECRAFT_PASSWORD} /reg a b`;
  const out = redact(leaked);
  for (const secret of [ENV.DISCORD_TOKEN, ENV.MINECRAFT_PASSWORD, 'dbPassw0rd']) assert.ok(!out.includes(secret), `leaked ${secret}: ${out}`);
  // Generic patterns catch tokens even when they are not configured values.
  const generic = createRedactor([])(`${FAKE_TOKEN} and /login hunter2`);
  assert.ok(!generic.includes('hunter2') && !generic.includes('GabcDE'));
});

test('logger persists redacted events to the outbox until they are sent', async () => {
  const db = await sqliteDb();
  const lines = [];
  const out = { log: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) };
  const logger = createLogger({ secretValues: ['Sup3rSecretPw'], out });
  await logger.info('test.event', 'before db Sup3rSecretPw');
  await logger.setDatabase(db);
  await logger.admin('test.admin', 'admin did a thing');
  await logger.debug('test.debug', 'console only');
  const unsent = await fetchUnsentEvents(db);
  assert.deepEqual(
    unsent.map((e) => [e.level, e.type]),
    [
      ['INFO', 'test.event'],
      ['ADMIN', 'test.admin']
    ]
  );
  assert.ok(!unsent[0].message.includes('Sup3rSecretPw'));
  assert.ok(lines.every((l) => !l.includes('Sup3rSecretPw')));
  await markEventsSent(db, unsent.map((e) => e.id));
  assert.equal((await fetchUnsentEvents(db)).length, 0);
});

test('config.example.json is structurally valid and lists what must be filled in', () => {
  const ok = loadSettings({ KITBOT_CONFIG: EXAMPLE }, { allowPlaceholders: true });
  assert.deepEqual(ok.errors, []);
  const strict = loadSettings({ KITBOT_CONFIG: EXAMPLE });
  assert.ok(strict.errors.some((e) => e.includes('navigation.home')));
  assert.ok(strict.errors.some((e) => e.includes('kits.totem.retrieval.container')));
});

test('the default kit directions follow the specification', () => {
  const s = testSettings();
  assert.equal(s.kits.totem.direction, 'left');
  assert.equal(s.kits.pvp.direction, 'right');
  assert.equal(s.kits.grief.direction, 'backward');
  assert.equal(s.limits.cooldownMinutes, 10);
  assert.equal(s.limits.dailyQuota, 10);
  assert.equal(s.limits.globalPerMinute, 2);
  assert.equal(s.linking.usernameChangeCooldownDays, 30);
  assert.deepEqual(validateSettings(s), []);
});

test('invalid settings are rejected', () => {
  const s = testSettings();
  s.kits.totem.direction = 'up';
  s.chat.patterns = ['(?<username>\\w+): (?<message>.+)'];
  s.limits.dailyQuota = 0;
  const errors = validateSettings(s);
  assert.ok(errors.some((e) => e.includes('kits.totem.direction')));
  assert.ok(errors.some((e) => e.includes('anchored')));
  assert.ok(errors.some((e) => e.includes('dailyQuota')));
});

test('the bot refuses to start until the server rules are confirmed', () => {
  assert.throws(() => loadConfig({ env: ENV, role: 'minecraft' }), /botsAllowedConfirmed/);
  // The Discord-only role does not connect to Minecraft.
  assert.throws(() => loadConfig({ env: ENV, role: 'discord' }), (e) => !/botsAllowedConfirmed/.test(e.message));
});

test('missing secrets are reported by name, never by value', () => {
  try {
    loadConfig({ env: { KITBOT_CONFIG: EXAMPLE, MINECRAFT_PASSWORD: 'Sup3rSecretPw' }, role: 'all', allowPlaceholders: true });
    assert.fail('should throw');
  } catch (e) {
    for (const name of ['MINECRAFT_HOST', 'MINECRAFT_USERNAME', 'DISCORD_TOKEN', 'DISCORD_GUILD_ID', 'DISCORD_LOG_CHANNEL_ID', 'DISCORD_ADMIN_IDS']) assert.match(e.message, new RegExp(name));
    assert.ok(!e.message.includes('Sup3rSecretPw'));
  }
});

test('outgoing chat is sanitised', () => {
  assert.equal(sanitizeOutgoing('hi\n/op Mallory §ksecret', 240), 'hi /op Mallory ksecret');
  assert.equal(sanitizeOutgoing('x'.repeat(400), 300).length, 256);
  assert.equal(fill('/msg {player} {message}', { player: 'Alice', message: 'hello' }), '/msg Alice hello');
  assert.equal(fill('/reg {password} {password}', { password: 'pw' }), '/reg pw pw');
});
