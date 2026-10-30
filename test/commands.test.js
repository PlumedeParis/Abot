'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCommand, createCommandHandler } = require('../src/commands');
const linking = require('../src/linking');
const bans = require('../src/bans');
const { settings, sqliteDb, fakeLogger, member } = require('./helpers');

const chat = settings().chat;

test('parseCommand', () => {
  assert.deepEqual(parseCommand('!kit pvp', chat), { type: 'kit', kit: 'pvp' });
  assert.deepEqual(parseCommand('!KIT   Totem ', chat), { type: 'kit', kit: 'totem' });
  assert.deepEqual(parseCommand('!kit', chat), { type: 'kit_usage' });
  assert.deepEqual(parseCommand('!kit food', chat), { type: 'kit_unknown' });
  assert.deepEqual(parseCommand('!link ABCD-EFGH', chat), { type: 'link', code: 'ABCD-EFGH' });
  assert.deepEqual(parseCommand('!link', chat), { type: 'link_usage' });
  assert.equal(parseCommand('hello !kit pvp', chat), null);
  assert.equal(parseCommand('Do !kit', chat), null);
  assert.equal(parseCommand('', chat), null);
});

async function setup({ runtime = {}, membership = member } = {}) {
  const db = await sqliteDb();
  const logger = fakeLogger();
  const replies = [];
  let clock = 1_000_000_000_000;
  const s = settings();
  const handle = createCommandHandler({
    db,
    getSettings: () => s,
    getRuntime: () => ({ ready: true, stationReady: true, paused: false, maintenance: false, ...runtime }),
    logger,
    checkMembership: membership,
    reply: async (name, msg) => void replies.push(`${name}: ${msg}`),
    now: () => clock
  });
  const tick = (ms) => (clock += ms);
  const linkSteve = async () => {
    const r = await linking.startLink(db, { discordId: '111111111111111111', name: 'Steve', settings: s, now: clock });
    tick(1000);
    return linking.completeLink(db, { name: 'Steve', uuid: 'uuid-steve', code: r.code, settings: s, checkMembership: member, now: clock });
  };
  return { db, logger, replies, handle, tick, linkSteve, s };
}

const steve = { username: 'Steve', uuid: 'uuid-steve' };

test('an unlinked player is told how to link', async () => {
  const t = await setup();
  const r = await t.handle('Steve', '!kit pvp', steve);
  assert.equal(r.reason, 'not linked');
  assert.equal(t.replies[0], 'Steve: Link your account first: join our Discord https://discord.gg/VTX6khDexE and run /link there, then whisper me "!link <code>".');
});

test('a linked player gets the kit queued, then cooldown and pending apply', async () => {
  const t = await setup();
  assert.equal((await t.linkSteve()).ok, true);
  const r = await t.handle('Steve', '!kit pvp', steve);
  assert.equal(r.accepted, true);
  assert.match(t.replies.at(-1), /Order received: pvp kit, position 1/);
  t.tick(5000);
  assert.equal((await t.handle('Steve', '!kit totem', steve)).reason, 'pending');
  await t.db.run("UPDATE requests SET status = 'delivered'");
  t.tick(5000);
  const c = await t.handle('Steve', '!kit totem', steve);
  assert.equal(c.reason, 'cooldown');
  assert.match(t.replies.at(-1), /Please wait 9m/);
});

test('commands sent too quickly are ignored', async () => {
  const t = await setup();
  await t.handle('Steve', '!kit', steve);
  assert.equal(await t.handle('Steve', '!kit', steve), null);
  t.tick(3000);
  assert.ok(await t.handle('Steve', '!kit', steve));
});

test('the bot says why it refuses: paused, maintenance, not ready, no chests', async () => {
  for (const [runtime, re] of [
    [{ paused: true }, /paused/],
    [{ maintenance: true }, /maintenance/],
    [{ ready: false }, /still starting/],
    [{ stationReady: false }, /not set up/]
  ]) {
    const t = await setup({ runtime });
    await t.linkSteve();
    await t.handle('Steve', '!kit pvp', steve);
    assert.match(t.replies.at(-1), re);
  }
});

test('bans, Discord outages and members who left', async () => {
  let t = await setup();
  await t.linkSteve();
  await bans.ban(t.db, { query: 'Steve', by: 'admin' });
  assert.equal((await t.handle('Steve', '!kit pvp', steve)).reason, 'banned');

  t = await setup({ membership: async () => ({ status: 'unavailable' }) });
  await linking.startLink(t.db, { discordId: '111111111111111111', name: 'Steve', settings: t.s });
  assert.equal((await t.handle('Steve', '!kit pvp', steve)).reason, 'not linked');

  t = await setup();
  await t.linkSteve();
  let status = 'member';
  const t2 = { ...t };
  const handle = createCommandHandler({
    db: t.db,
    getSettings: () => t.s,
    getRuntime: () => ({ ready: true, stationReady: true }),
    logger: t.logger,
    checkMembership: async () => ({ status }),
    reply: async () => {}
  });
  status = 'not_member';
  assert.equal((await handle('Steve', '!kit pvp', steve)).reason, 'left the Discord server');
  assert.equal(await linking.activeLinkByUsername(t2.db, 'Steve'), undefined, 'the link was removed');
});

test('!link from the game completes the link', async () => {
  const t = await setup();
  const code = (await linking.startLink(t.db, { discordId: '222222222222222222', name: 'Steve', settings: t.s })).code;
  const r = await t.handle('Steve', `!link ${code}`, steve);
  assert.equal(r.ok, true);
  assert.match(t.replies.at(-1), /Linked to your Discord account/);
  t.tick(3000);
  assert.equal((await t.handle('Steve', '!link WRON-GCOD', steve)).reason, 'invalid_code');
});
