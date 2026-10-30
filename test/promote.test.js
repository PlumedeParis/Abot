'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPromoter } = require('../src/promote');
const { settings, fakeLogger } = require('./helpers');

function setup(runtime = {}) {
  let clock = 1_000_000;
  const said = [];
  const whispers = [];
  const rt = { ready: true, stationReady: true, paused: false, maintenance: false, ...runtime };
  const s = settings();
  const p = createPromoter({
    getSettings: () => s,
    getRuntime: () => rt,
    logger: fakeLogger(),
    say: async (t) => void said.push(t),
    whisper: async (n, t) => void whispers.push(`${n}: ${t}`),
    now: () => clock
  });
  return { p, said, whispers, rt, s, tick: (ms) => (clock += ms) };
}

const MIN = 60000;

test('the public message goes out every 30 minutes', async () => {
  const t = setup();
  t.p.loggedIn();
  assert.equal(await t.p.tick(), false, 'not right after logging in');
  t.tick(29 * MIN);
  assert.equal(await t.p.tick(), false);
  t.tick(1 * MIN);
  assert.equal(await t.p.tick(), true);
  assert.deepEqual(t.said, ['order a kit by typing !kit totem/pvp/grief']);
  t.tick(10 * MIN);
  assert.equal(await t.p.tick(), false);
  t.tick(20 * MIN);
  assert.equal(await t.p.tick(), true);
  assert.equal(t.said.length, 2);
});

test('no advertising while deliveries are impossible, or when turned off', async () => {
  for (const runtime of [{ paused: true }, { maintenance: true }, { stationReady: false }, { ready: false }]) {
    const t = setup(runtime);
    t.p.loggedIn();
    t.tick(31 * MIN);
    assert.equal(await t.p.tick(), false, JSON.stringify(runtime));
    assert.equal(await t.p.playerJoined('Steve'), false);
  }
  const t = setup();
  t.s.chat.advertisement.message = '';
  t.s.chat.welcome.message = '';
  t.p.loggedIn();
  t.tick(31 * MIN);
  assert.equal(await t.p.tick(), false);
  t.tick(MIN);
  assert.equal(await t.p.playerJoined('Steve'), false);
});

test('players who join get a private message, once every 6 hours', async () => {
  const t = setup();
  assert.equal(await t.p.playerJoined('Steve'), false, 'not before the bot is logged in');
  t.p.loggedIn();
  assert.equal(await t.p.playerJoined('Steve'), false, 'players already online when the bot logs in');
  t.tick(16000);
  assert.equal(await t.p.playerJoined('Steve', { botName: 'VoidKits' }), true);
  assert.deepEqual(t.whispers, ['Steve: order a free kit by doing !kit totem/pvp/grief']);
  t.tick(MIN);
  assert.equal(await t.p.playerJoined('steve'), false, 'rejoining soon after');
  assert.equal(await t.p.playerJoined('VoidKits', { botName: 'VoidKits' }), false, 'not the bot itself');
  assert.equal(await t.p.playerJoined('Alex', { pending: 5 }), false, 'not when messages are piling up');
  t.tick(6 * 60 * MIN);
  assert.equal(await t.p.playerJoined('Steve'), true, 'again after 6 hours');
  t.p.loggedOut();
  assert.equal(await t.p.playerJoined('Notch'), false, 'not while disconnected');
});
