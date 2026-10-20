'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCommand, parseChatLine, compilePatterns, createRequestHandler } = require('../src/requests');
const linking = require('../src/linking');
const { sqliteDb, testSettings, fakeLogger, member, MIN } = require('./helpers');

const S = testSettings();
const T0 = Date.UTC(2026, 0, 1);
const DISCORD = '500000000000000001';

test('parseCommand accepts only well-formed !kit commands, case-insensitively', () => {
  assert.deepEqual(parseCommand('!kit totem', S.chat), { type: 'kit', kit: 'totem' });
  assert.deepEqual(parseCommand('!kit PVP', S.chat), { type: 'kit', kit: 'pvp' });
  assert.deepEqual(parseCommand('  !KIT Grief ', S.chat), { type: 'kit', kit: 'grief' });
  assert.deepEqual(parseCommand('!kit sword', S.chat), { type: 'kit_unknown' });
  assert.deepEqual(parseCommand("!kit totem'; DROP TABLE links;--", S.chat), { type: 'kit_usage' });
  assert.deepEqual(parseCommand('!kit', S.chat), { type: 'kit_usage' });
  assert.deepEqual(parseCommand('!kit totem pvp', S.chat), { type: 'kit_usage' });
  assert.deepEqual(parseCommand('!link ABCD-2345', S.chat), { type: 'link', code: 'ABCD-2345' });
  for (const chat of ['hello', 'I want a !kit totem', '!kits', 'kit totem', '!kittotem', '']) assert.equal(parseCommand(chat, S.chat), null, chat);
});

test('parseChatLine extracts the real sender and resists spoofing', () => {
  const pats = compilePatterns(S.chat.patterns);
  assert.deepEqual(parseChatLine('<Steve> !kit totem', pats), { username: 'Steve', message: '!kit totem' });
  assert.deepEqual(parseChatLine('Steve whispers: !link ABCD-2345', pats), { username: 'Steve', message: '!link ABCD-2345' });
  // A player typing a fake whisper in public chat stays attributed to themselves.
  assert.deepEqual(parseChatLine('<Mallory> Steve whispers: !kit totem', pats), { username: 'Mallory', message: 'Steve whispers: !kit totem' });
  assert.equal(parseChatLine('[Server] Steve joined the game', pats), null);
  assert.equal(parseChatLine('<Bad Name!> !kit totem', pats), null);
});

async function setup({ runtime = {}, membership = member, online = ['Alice', 'Bob'] } = {}) {
  const db = await sqliteDb();
  const logger = fakeLogger();
  const replies = [];
  const clock = { t: T0 };
  const rt = { paused: false, maintenance: false, minecraftReady: true, ...runtime };
  let queued = 0;
  const handle = createRequestHandler({
    db,
    getSettings: () => S,
    getRuntime: () => rt,
    logger,
    checkMembership: (...a) => membership(...a),
    getOnlinePlayer: (name) => (online.includes(name) ? { username: name, uuid: null } : null),
    reply: async (player, msg) => replies.push({ player, msg }),
    onQueued: () => queued++,
    now: () => clock.t
  });
  const linkAlice = async () => {
    const s = await linking.startLink(db, { discordId: DISCORD, mcUsername: 'Alice', settings: S, now: clock.t });
    return handle('Alice', `!link ${s.code}`);
  };
  return { db, logger, replies, clock, rt, handle, linkAlice, queuedCount: () => queued };
}

test('normal chat is ignored and unknown kits get the list of kits', async () => {
  const h = await setup();
  assert.equal(await h.handle('Alice', 'hi everyone'), null);
  assert.equal(h.replies.length, 0);
  await h.handle('Alice', '!kit sword');
  assert.equal(h.replies.at(-1).msg, 'Unknown kit. Available kits: totem, pvp, grief.');
});

test('unlinked players cannot request kits', async () => {
  const h = await setup();
  const r = await h.handle('Bob', '!kit totem');
  assert.equal(r.reason, 'not_linked');
  assert.match(h.replies.at(-1).msg, /link your account/);
});

test('players not visible online (possible spoof) are ignored', async () => {
  const h = await setup({ online: [] });
  assert.equal(await h.handle('Alice', '!kit totem'), null);
});

test('full flow: link in game, request, queue, cooldown message', async () => {
  const h = await setup();
  const l = await h.linkAlice();
  assert.equal(l.ok, true);
  h.clock.t += 5000;
  const r = await h.handle('Alice', '!kit TOTEM');
  assert.equal(r.accepted, true);
  assert.equal(h.replies.at(-1).msg, 'Your request has been queued for delivery (position 1).');
  assert.equal(h.queuedCount(), 1);
  await h.db.run("UPDATE requests SET status = 'delivered', completed_at = ?", [h.clock.t + 1000]);
  h.clock.t += MIN;
  const again = await h.handle('Alice', '!kit pvp');
  assert.equal(again.reason, 'cooldown');
  assert.match(h.replies.at(-1).msg, /^You must wait before requesting another kit/);
  assert.ok(h.logger.has('limit.cooldown'));
});

test('duplicate messages within the window are processed once', async () => {
  const h = await setup();
  await h.linkAlice();
  h.clock.t += 5000;
  const a = await h.handle('Alice', '!kit totem');
  const b = await h.handle('Alice', '!kit totem');
  assert.equal(a.accepted, true);
  assert.equal(b, null);
  assert.equal(Number((await h.db.get('SELECT COUNT(*) AS n FROM requests')).n), 1);
});

test('paused and maintenance modes reject new requests', async () => {
  const h = await setup({ runtime: { paused: true } });
  await h.linkAlice();
  h.clock.t += 5000;
  assert.equal((await h.handle('Alice', '!kit totem')).reason, 'paused');
  h.rt.paused = false;
  h.rt.maintenance = true;
  h.clock.t += 5000;
  assert.equal((await h.handle('Alice', '!kit grief')).reason, 'maintenance');
});

test('leaving Discord revokes access immediately at request time', async () => {
  let status = 'member';
  const h = await setup({ membership: async () => ({ status }) });
  await h.linkAlice();
  status = 'not_member';
  h.clock.t += 5000;
  const r = await h.handle('Alice', '!kit totem');
  assert.equal(r.reason, 'not_member');
  assert.equal(await linking.getActiveLinkByUsername(h.db, 'Alice'), undefined, 'link revoked');
  assert.ok(h.logger.has('link.revoked'));
  // Rejoining is not enough: the player must link again.
  status = 'member';
  h.clock.t += 5000;
  assert.equal((await h.handle('Alice', '!kit pvp')).reason, 'not_linked');
});

test('Discord outage: requests are rejected, links are kept', async () => {
  let status = 'member';
  const h = await setup({ membership: async () => ({ status }) });
  await h.linkAlice();
  status = 'unavailable';
  h.clock.t += 5000;
  assert.equal((await h.handle('Alice', '!kit totem')).reason, 'discord_unavailable');
  assert.ok(await linking.getActiveLinkByUsername(h.db, 'Alice'));
  assert.equal(Number((await h.db.get('SELECT COUNT(*) AS n FROM requests')).n), 0);
});
