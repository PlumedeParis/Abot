'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bans = require('../src/bans');
const { recordStock, readStock } = require('../src/stock');
const linking = require('../src/linking');
const { createRequestHandler } = require('../src/requests');
const { sqliteDb, testSettings, fakeLogger, member } = require('./helpers');

const S = testSettings();
const ALICE = '510000000000000001';

async function linked(db, discordId, name) {
  const s = await linking.startLink(db, { discordId, mcUsername: name, settings: S, now: 1000 });
  await linking.completeLink(db, { mcUsername: name, code: s.code, settings: S, checkMembership: member, now: 2000 });
}

function handler(db) {
  const replies = [];
  const clock = { t: Date.now() };
  const handle = createRequestHandler({
    db,
    getSettings: () => S,
    getRuntime: () => ({ minecraftReady: true }),
    logger: fakeLogger(),
    checkMembership: member,
    getOnlinePlayer: (name) => ({ username: name, uuid: null }),
    reply: async (player, msg) => replies.push(msg),
    now: () => (clock.t += 10000)
  });
  return { handle, replies };
}

test('a banned player cannot order kits; unban restores access', async () => {
  const db = await sqliteDb();
  await linked(db, ALICE, 'Alice');
  const h = handler(db);
  assert.equal((await bans.banPlayer(db, { query: 'alice', reason: 'trap', bannedBy: 'admin' })).ok, true);
  const r = await h.handle('Alice', '!kit totem');
  assert.equal(r.reason, 'banned');
  assert.equal(h.replies.at(-1), 'You are banned from the kit bot.');
  assert.equal(await bans.unbanPlayer(db, 'Alice'), 1);
  assert.equal((await h.handle('Alice', '!kit totem')).accepted, true);
});

test('banning a linked player also bans their Discord account (no new-account bypass)', async () => {
  const db = await sqliteDb();
  await linked(db, ALICE, 'Alice');
  // A code for a second account, requested just before the ban...
  const code = await linking.startLink(db, { discordId: ALICE, mcUsername: 'AliceAlt', settings: S, now: Date.now() });
  const b = await bans.banPlayer(db, { query: 'Alice', bannedBy: 'admin' });
  assert.equal(b.discordId, ALICE);
  // ...no longer works after it.
  const h = handler(db);
  assert.equal((await h.handle('AliceAlt', `!link ${code.code}`)).ok, false);
  assert.equal(await linking.getActiveLinkByUsername(db, 'AliceAlt'), undefined);
  // Any account linked to that Discord user is blocked (Discord /link checks this too).
  assert.ok(await bans.findBan(db, { mcUsername: 'SomeoneElse', discordId: ALICE }));
  assert.equal((await bans.banPlayer(db, { query: `<@${ALICE}>`, bannedBy: 'admin' })).reason, 'already_banned');
});

test('banning cancels waiting orders, and unknown players can be banned by name', async () => {
  const db = await sqliteDb();
  await db.run("INSERT INTO requests (discord_id, mc_username, mc_username_lower, kit, status, created_at) VALUES ('1', 'Bob', 'bob', 'pvp', 'queued', 1)");
  const b = await bans.banPlayer(db, { query: 'Bob', bannedBy: 'admin' });
  assert.equal(b.ok, true);
  assert.equal(b.discordId, null);
  assert.equal((await db.get('SELECT status FROM requests')).status, 'cancelled');
  assert.equal((await bans.listBans(db)).length, 1);
  assert.equal((await bans.banPlayer(db, { query: 'not a name!', bannedBy: 'admin' })).reason, 'invalid');
});

test('stock alerts fire once when low, once when empty, once when restocked', async () => {
  const db = await sqliteDb();
  const logger = fakeLogger();
  const rec = (left) => recordStock(db, logger, { kit: 'totem', left, lowThreshold: 5 });
  await rec(20);
  await rec(6);
  assert.equal(logger.events.length, 0, 'nothing above the threshold');
  await rec(5);
  await rec(4);
  await rec(1);
  assert.deepEqual(logger.events.map((e) => e.type), ['stock.low'], 'one low alert');
  await rec(0);
  await rec(0);
  assert.deepEqual(logger.events.map((e) => e.type), ['stock.low', 'stock.empty'], 'one empty alert');
  await rec(30);
  assert.equal(logger.events.at(-1).type, 'stock.restocked');
  assert.equal((await readStock(db)).totem.left, 30);
});
