'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectStation, step, facingFromYaw, f3ToYaw } = require('../src/station');
const { loadSettings, loadConfig, validateSettings, secretValues, loadSecrets, DEFAULTS } = require('../src/config');
const { createRedactor } = require('../src/log');
const { isAdmin, createConfirmations } = require('../src/discord/admin');
const { settings } = require('./helpers');

const kits = DEFAULTS.kits;

// A station seen from (0, 64, 0) facing `facing`: totem left, pvp right, grief in front.
function world(facing, extra = {}) {
  const blocks = { ...extra };
  for (const [name, dist] of [
    ['left', 2],
    ['right', 3],
    ['forward', 2]
  ]) {
    const d = step(facing, name);
    blocks[`${d.x * dist},64,${d.z * dist}`] = 'chest';
  }
  return (p) => (blocks[`${p.x},${p.y},${p.z}`] ? { name: blocks[`${p.x},${p.y},${p.z}`] } : { name: 'air' });
}

test('directions', () => {
  assert.deepEqual(step('north', 'forward'), { x: 0, z: -1 });
  assert.deepEqual(step('north', 'left'), { x: -1, z: 0 });
  assert.deepEqual(step('north', 'right'), { x: 1, z: 0 });
  assert.deepEqual(step('east', 'left'), { x: 0, z: -1 });
  for (const f of ['north', 'south', 'east', 'west']) assert.equal(facingFromYaw(f3ToYaw({ south: 0, west: 90, north: 180, east: -90 }[f])), f);
});

test('station detection, including when the bot faces the wrong way', () => {
  const pos = { x: 0.5, y: 64, z: 0.5 };
  const ok = detectStation({ position: pos, yaw: f3ToYaw(180), blockAt: world('north'), kits });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.kits.totem.container, { x: -2, y: 64, z: 0 });
  assert.deepEqual(ok.kits.totem.standAt, { x: -1, y: 64, z: 0 });
  assert.deepEqual(ok.kits.grief.container, { x: 0, y: 64, z: -2 });

  const turned = detectStation({ position: pos, yaw: f3ToYaw(0), blockAt: world('east'), kits });
  assert.equal(turned.ok, true);
  assert.equal(turned.turned, true);
  assert.equal(turned.home.facing, 'east');

  const missing = detectStation({ position: pos, yaw: 0, blockAt: () => ({ name: 'air' }), kits });
  assert.deepEqual(missing.missing, ['totem', 'pvp', 'grief']);

  const fixed = detectStation({ position: pos, yaw: 0, facing: 'west', blockAt: world('west'), kits });
  assert.equal(fixed.ok, true);
});

test('settings: defaults are valid, mistakes are reported', () => {
  assert.deepEqual(validateSettings(settings()), []);
  const bad = settings({ chat: { kitCommand: 'kit', patterns: ['(?<username>x)'] }, kits: { food: {} }, navigation: { home: { x: 1 } }, delivery: { method: 'fly' } });
  const errors = validateSettings(bad).join('\n');
  for (const re of [/kitCommand/, /patterns\[0\]/, /kits.food/, /navigation.home/, /delivery.method/]) assert.match(errors, re);
  const fromJson = loadSettings({ KITBOT_CONFIG_JSON: Buffer.from(JSON.stringify({ limits: { dailyQuota: 3 } })).toString('base64') });
  assert.equal(fromJson.settings.limits.dailyQuota, 3);
});

test('secrets are required and never printed', () => {
  const env = { MINECRAFT_HOST: 'h', MINECRAFT_USERNAME: 'VoidKits', MINECRAFT_PASSWORD: 'Plume2', DISCORD_TOKEN: 'abc.def.ghi', KITBOT_BOTS_ALLOWED: 'true' };
  assert.equal(loadConfig({ env }).secrets.minecraft.username, 'VoidKits');
  assert.throws(() => loadConfig({ env: { ...env, KITBOT_BOTS_ALLOWED: '' } }), /rules must allow bots/);
  assert.throws(() => loadConfig({ env: { ...env, DISCORD_TOKEN: '' } }), /DISCORD_TOKEN/);
  const redact = createRedactor(secretValues(loadSecrets(env)));
  assert.equal(redact('sent /log Plume2 and token abc.def.ghi'), 'sent /log [REDACTED] and token [REDACTED]');
  assert.equal(redact('/reg hunter2 hunter2'), '/reg [REDACTED]');
});

test('admin checks and confirmations', () => {
  const cfg = { adminIds: ['111111111111111111'], guildId: '999999999999999999' };
  assert.equal(isAdmin({ userId: '111111111111111111', guildId: '999999999999999999' }, cfg), true);
  assert.equal(isAdmin({ userId: '111111111111111111', guildId: '888888888888888888' }, cfg), false);
  assert.equal(isAdmin({ userId: '222222222222222222', guildId: '999999999999999999' }, cfg), false);
  let now = 0;
  const c = createConfirmations({ ttlMs: 1000, now: () => now });
  const n = c.create('a', 'unlink', { player: 'Steve' });
  assert.equal(c.consume(n, 'b').reason, 'not_yours');
  assert.equal(c.consume(n, 'a').ok, true);
  assert.equal(c.consume(n, 'a').ok, false, 'single use');
  const late = c.create('a', 'unlink', {});
  now = 2000;
  assert.equal(c.consume(late, 'a').reason, 'expired');
});

test('the Discord slash commands are valid', () => {
  const { buildCommands } = require('../src/discord/bot');
  const names = buildCommands().map((c) => c.name);
  assert.deepEqual(names, ['kitbot', 'link', 'linkstatus']);
  const subs = buildCommands()[0].options.map((o) => o.name);
  assert.equal(subs.length, 19);
});
