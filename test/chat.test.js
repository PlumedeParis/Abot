'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const chat = require('../src/chat');
const { DEFAULTS } = require('../src/config');

const opts = {
  online: ['Plume_the_cat', 'Steve', 'Mallory', 'VoidKits'],
  botName: 'VoidKits',
  ignore: new RegExp(DEFAULTS.chat.ignorePattern, 'i')
};
const read = (line, o = opts) => chat.parseSystemLine(line, o);
const said = (username, message) => ({ username, message });

test('reads the 1b1t.cc chat format, with ranks of several words', () => {
  assert.deepEqual(read('OG 1b1ter Plume_the_cat » !kit pvp'), said('Plume_the_cat', '!kit pvp'));
  assert.deepEqual(read('Plume_the_cat » !kit totem'), said('Plume_the_cat', '!kit totem'));
  assert.deepEqual(read('§6OG 1b1ter §fPlume_the_cat §7» §f!kit grief'), said('Plume_the_cat', '!kit grief'));
  assert.deepEqual(read('OG 1b1ter steve » !KIT PVP'), said('Steve', '!KIT PVP'), 'the tab-list spelling is used');
});

test('ignores lines relayed from Discord (their authors are not in game)', () => {
  assert.equal(read('[1b1tDiscord] OG 1b1ter Plume_the_cat » Do !kit'), null);
  assert.equal(read('[Discord] Steve » !kit pvp'), null);
});

test('reads vanilla and common plugin formats', () => {
  assert.deepEqual(read('<Steve> !kit grief'), said('Steve', '!kit grief'));
  assert.deepEqual(read('[VIP] <Steve> !kit grief'), said('Steve', '!kit grief'));
  assert.deepEqual(read('[VIP] Steve: !kit totem'), said('Steve', '!kit totem'));
  assert.deepEqual(read('Steve > !kit totem'), said('Steve', '!kit totem'));
  assert.deepEqual(read('Steve ➤ !kit totem'), said('Steve', '!kit totem'));
  assert.deepEqual(read('[Owner] ✦ Steve ✦ » !kit totem'), said('Steve', '!kit totem'));
});

test('reads whispers to the bot', () => {
  assert.deepEqual(read('Steve whispers to you: !link ABCD-EFGH'), said('Steve', '!link ABCD-EFGH'));
  assert.deepEqual(read('Steve whispers: !link ABCD-EFGH'), said('Steve', '!link ABCD-EFGH'));
  assert.deepEqual(read('[Steve -> me] !link ABCD-EFGH'), said('Steve', '!link ABCD-EFGH'));
  assert.deepEqual(read('[Steve -> VoidKits] !kit pvp'), said('Steve', '!kit pvp'));
  assert.deepEqual(read('From Steve: !kit pvp'), said('Steve', '!kit pvp'));
  assert.deepEqual(read('Steve -> You: !kit pvp'), said('Steve', '!kit pvp'));
  assert.deepEqual(read('[VIP] Steve → me » !kit pvp'), said('Steve', '!kit pvp'));
});

test('a player cannot speak in another player name', () => {
  // Whatever Mallory types comes after the separator, so it is Mallory's message.
  assert.deepEqual(read('Mallory » <Steve> !kit pvp'), said('Mallory', '<Steve> !kit pvp'));
  assert.deepEqual(read('Mallory » Steve whispers: !kit pvp'), said('Mallory', 'Steve whispers: !kit pvp'));
  assert.deepEqual(read('Mallory: [Steve -> me] !kit'), said('Mallory', '[Steve -> me] !kit'));
  assert.deepEqual(read('<Mallory> Steve: !kit pvp'), said('Mallory', 'Steve: !kit pvp'));
  assert.deepEqual(read('OG 1b1ter Mallory » Steve » !kit pvp'), said('Mallory', 'Steve » !kit pvp'));
});

test('ignores the bot own whispers, server messages and offline names', () => {
  assert.equal(read('[me -> Steve] Your kit is ready'), null);
  assert.equal(read('[VoidKits -> Steve] Your kit is ready'), null);
  assert.equal(read('To Steve: Your kit is ready'), null);
  assert.equal(read('You whisper to Steve: hi'), null);
  assert.equal(read('Ghost » !kit pvp'), null, 'not in the tab list');
  assert.equal(read('Tip: type !kit pvp'), null);
  assert.equal(read('Steve joined the game'), null);
  assert.equal(read(''), null);
});

test('extra configured patterns are tried first', () => {
  const o = { ...opts, patterns: [/^\(\s*(?<username>\w+)\s*\) (?<message>.+)$/i] };
  assert.deepEqual(read('( Steve ) !kit pvp', o), said('Steve', '!kit pvp'));
  assert.equal(read('( Ghost ) !kit pvp', o), null);
});

test('player chat packets: the sender comes from the UUID, the text is exact', () => {
  const ctx = { playersByUuid: { 'uuid-steve': 'Steve' }, online: opts.online };
  assert.deepEqual(chat.parsePlayerChat({ senderUuid: 'uuid-steve', plainMessage: '!kit pvp', senderName: '[VIP] Steve' }, ctx), said('Steve', '!kit pvp'));
  // Unknown UUID: the display name decides, and must be online.
  assert.deepEqual(chat.parsePlayerChat({ senderUuid: 'x', plainMessage: '!kit pvp', senderName: 'OG 1b1ter Mallory' }, ctx), said('Mallory', '!kit pvp'));
  assert.equal(chat.parsePlayerChat({ senderUuid: 'x', plainMessage: '!kit pvp', senderName: 'Ghost' }, ctx), null);
  assert.equal(chat.parsePlayerChat({ senderUuid: 'uuid-steve', plainMessage: '   ' }, ctx), null);
});

test('profileless chat packets', () => {
  assert.deepEqual(chat.parseProfilelessChat({ senderName: 'OG 1b1ter Steve', message: '!kit totem' }, { online: opts.online }), said('Steve', '!kit totem'));
  assert.equal(chat.parseProfilelessChat({ senderName: 'Ghost', message: '!kit totem' }, { online: opts.online }), null);
});

test('chat components to text', () => {
  assert.equal(chat.componentText('{"text":"Steve"}'), 'Steve');
  assert.equal(chat.componentText({ text: '', extra: [{ text: 'OG ' }, { text: 'Steve', color: 'gold' }, ' » ', { text: '!kit pvp' }] }), 'OG Steve » !kit pvp');
  assert.equal(chat.componentText('plain text'), 'plain text');
  assert.equal(chat.componentText(null), '');
  assert.equal(chat.cleanText('  §aHi​  there '), 'Hi there');
});
