'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPromoter } = require('../src/promote');
const { settings, fakeLogger } = require('./helpers');

function setup(runtime = {}) {
  let clock = 1_000_000;
  const whispers = [];
  const rt = { ready: true, stationReady: true, paused: false, maintenance: false, ...runtime };
  const s = settings();
  const p = createPromoter({
    getSettings: () => s,
    getRuntime: () => rt,
    logger: fakeLogger(),
    whisper: async (n, t) => void whispers.push(`${n}: ${t}`),
    now: () => clock
  });
  return { p, whispers, rt, s, tick: (ms) => (clock += ms) };
}

const MIN = 60000;

test('there is no timed public message', () => {
  const t = setup();
  assert.equal(t.p.tick, undefined);
  assert.equal(settings().chat.advertisement, undefined);
});

test('no welcome while deliveries are impossible, or when turned off', async () => {
  for (const runtime of [{ paused: true }, { maintenance: true }, { stationReady: false }, { ready: false }]) {
    const t = setup(runtime);
    t.p.loggedIn();
    t.tick(MIN);
    assert.equal(await t.p.playerJoined('Steve'), false, JSON.stringify(runtime));
  }
  const t = setup();
  t.s.chat.welcome.message = '';
  t.p.loggedIn();
  t.tick(MIN);
  assert.equal(await t.p.playerJoined('Steve'), false);
  assert.deepEqual(t.whispers, []);
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
