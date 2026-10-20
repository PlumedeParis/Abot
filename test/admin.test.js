'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isAuthorizedAdmin, createConfirmationStore, createAdminActions } = require('../src/admin');
const { createMembershipChecker } = require('../src/membership');
const { getSetting } = require('../src/database');
const linking = require('../src/linking');
const limits = require('../src/limits');
const { DiscordAPIError } = require('discord.js');
const { sqliteDb, testSettings, fakeLogger, member, ADMIN_ID, GUILD_ID } = require('./helpers');

const CFG = { adminIds: [ADMIN_ID], guildId: GUILD_ID };
const S = testSettings();

test('only allowlisted administrators in the configured guild are authorised', () => {
  assert.equal(isAuthorizedAdmin({ userId: ADMIN_ID, guildId: GUILD_ID }, CFG), true);
  assert.equal(isAuthorizedAdmin({ userId: '999999999999999999', guildId: GUILD_ID }, CFG), false, 'not in allowlist');
  assert.equal(isAuthorizedAdmin({ userId: ADMIN_ID, guildId: '333333333333333333' }, CFG), false, 'other guild');
  assert.equal(isAuthorizedAdmin({ userId: ADMIN_ID, guildId: null }, CFG), false, 'direct message');
  assert.equal(isAuthorizedAdmin({ userId: `${ADMIN_ID} `, guildId: GUILD_ID }, CFG), false, 'manipulated id');
  assert.equal(isAuthorizedAdmin({ userId: undefined, guildId: GUILD_ID }, CFG), false);
  assert.equal(isAuthorizedAdmin({ userId: ADMIN_ID, guildId: GUILD_ID }, { adminIds: [], guildId: GUILD_ID }), false, 'empty allowlist denies all');
});

test('confirmations are single-use, owner-only and expire', () => {
  const clock = { t: 0 };
  const store = createConfirmationStore({ ttlMs: 60000, now: () => clock.t });
  const n = store.create(ADMIN_ID, 'unlink', { player: 'Alice' });
  assert.equal(store.consume(n, '999999999999999999').reason, 'not_yours');
  assert.deepEqual(store.consume(n, ADMIN_ID), { ok: true, action: 'unlink', args: { player: 'Alice' } });
  assert.equal(store.consume(n, ADMIN_ID).ok, false, 'cannot be replayed');
  const late = store.create(ADMIN_ID, 'quota-reset', { player: 'Alice' });
  clock.t = 60001;
  assert.equal(store.consume(late, ADMIN_ID).reason, 'expired');
});

test('admin actions change shared state and are logged as ADMIN', async () => {
  const db = await sqliteDb();
  const logger = fakeLogger();
  const actions = createAdminActions({ db, logger, getSettings: () => S });
  const admin = { id: ADMIN_ID, tag: 'admin' };
  await actions.pause(admin);
  assert.equal(await getSetting(db, 'paused'), true);
  await actions.resume(admin);
  assert.equal(await getSetting(db, 'paused'), false);
  await actions.maintenance(admin, true);
  assert.equal(await getSetting(db, 'maintenance'), true);
  assert.ok(logger.events.filter((e) => e.level === 'ADMIN').length >= 3);
  assert.ok(logger.has('maintenance.on'));
});

test('admin unlink, cooldown-reset and quota-reset target the right player', async () => {
  const db = await sqliteDb();
  const logger = fakeLogger();
  const actions = createAdminActions({ db, logger, getSettings: () => S });
  const admin = { id: ADMIN_ID, tag: 'admin' };
  const did = '600000000000000001';
  const s = await linking.startLink(db, { discordId: did, mcUsername: 'Alice', settings: S, now: 1000 });
  await linking.completeLink(db, { mcUsername: 'Alice', code: s.code, settings: S, checkMembership: member, now: 2000 });
  const now = Date.now();
  const r = await limits.reserve(db, { discordId: did, mcUsername: 'Alice', kit: 'totem', limits: S.limits, now: now - 60000 });
  await db.run("UPDATE requests SET status = 'delivered' WHERE id = ?", [r.request.id]);

  assert.ok((await limits.usage(db, did, S.limits)).cooldownRemainingMs > 0);
  await actions.cooldownReset(admin, 'alice');
  assert.equal((await limits.usage(db, did, S.limits)).cooldownRemainingMs, 0);
  await actions.quotaReset(admin, 'Alice');
  assert.equal((await limits.usage(db, did, S.limits)).quotaUsed, 0);

  const info = await actions.player('Alice');
  assert.equal(info.discordId, did);
  const revoked = await actions.unlink(admin, 'Alice');
  assert.equal(revoked.length, 1);
  assert.equal(await linking.getActiveLinkByUsername(db, 'Alice'), undefined);
  assert.equal(await actions.cooldownReset(admin, 'Nobody'), null);
});

function apiError(code, status) {
  return new DiscordAPIError({ code, message: 'err' }, code, status, 'GET', '/guilds/x/members/y', {});
}

test('membership checker: member, left, missing role, and fail-closed on errors', async () => {
  const uid = '700000000000000001';
  const make = (impl, requiredRoleId = null) => createMembershipChecker({ token: 'x', guildId: GUILD_ID, requiredRoleId, rest: { get: impl } });
  assert.equal((await make(async () => ({ user: { id: uid }, roles: [] }))(uid)).status, 'member');
  assert.equal((await make(async () => ({ user: { id: uid }, roles: [] }), '800000000000000001')(uid)).status, 'missing_role');
  assert.equal((await make(async () => ({ user: { id: uid }, roles: ['800000000000000001'] }), '800000000000000001')(uid)).status, 'member');
  assert.equal(
    (await make(async () => {
      throw apiError(10007, 404);
    })(uid)).status,
    'not_member'
  );
  assert.equal(
    (await make(async () => {
      throw apiError(0, 500);
    })(uid)).status,
    'unavailable'
  );
  assert.equal(
    (await make(async () => {
      throw new Error('ETIMEDOUT');
    })(uid)).status,
    'unavailable'
  );
  assert.equal((await make(async () => ({}))('not-an-id')).status, 'not_member');
});
