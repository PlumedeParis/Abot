'use strict';

// Drives the real Discord handlers with simulated interactions (no network).

const test = require('node:test');
const assert = require('node:assert/strict');
const { Events } = require('discord.js');
const { createDiscordBot, buildCommands, eventEmbed } = require('../src/discord');
const { getSetting } = require('../src/database');
const linking = require('../src/linking');
const { sqliteDb, testSettings, fakeLogger, member, ADMIN_ID, GUILD_ID } = require('./helpers');

const S = testSettings();
const OTHER = '900000000000000009';

function config() {
  return {
    settings: S,
    secrets: {
      minecraft: { username: 'KitBot' },
      discord: { token: 'x', guildId: GUILD_ID, logChannelId: '123456789012345678', adminIds: [ADMIN_ID] },
      database: {}
    }
  };
}

function fakeInteraction({ userId, guildId = GUILD_ID, command = 'kitbot', sub, options = {}, customId = null }) {
  const calls = [];
  const it = {
    user: { id: userId, tag: `user${userId.slice(-2)}` },
    guildId,
    customId,
    commandName: command,
    deferred: false,
    replied: false,
    calls,
    isChatInputCommand: () => !customId,
    isButton: () => !!customId,
    isRepliable: () => true,
    options: {
      getSubcommand: () => sub,
      getString: (n) => options[n] ?? null,
      getBoolean: (n) => options[n] ?? null
    },
    reply: async (p) => {
      it.replied = true;
      calls.push(['reply', p]);
    },
    deferReply: async (p) => {
      it.deferred = true;
      calls.push(['deferReply', p]);
    },
    editReply: async (p) => calls.push(['editReply', p]),
    update: async (p) => calls.push(['update', p])
  };
  return it;
}

async function dispatch(bot, interaction) {
  bot.client.emit(Events.InteractionCreate, interaction);
  // Handlers are async; give them a moment to finish.
  for (let i = 0; i < 50 && interaction.calls.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 20));
}

async function setup() {
  const db = await sqliteDb();
  const logger = fakeLogger();
  const bot = createDiscordBot({ config: config(), db, logger, checkMembership: member });
  return { db, logger, bot };
}

test('slash command definitions are valid', () => {
  const cmds = buildCommands();
  const kitbot = cmds.find((c) => c.name === 'kitbot');
  assert.deepEqual(
    kitbot.options.map((o) => o.name),
    ['status', 'stats', 'player', 'queue', 'pause', 'resume', 'maintenance', 'unlink', 'cooldown-reset', 'quota-reset', 'reload', 'recalibrate', 'say', 'logs', 'help']
  );
  assert.equal(kitbot.default_member_permissions, '8', 'hidden from non-administrators by default');
  assert.ok(cmds.find((c) => c.name === 'link'));
});

test('non-administrators cannot run /kitbot commands, even when invoking them directly', async () => {
  const { db, logger, bot } = await setup();
  for (const sub of ['pause', 'maintenance', 'unlink', 'status', 'logs']) {
    const it = fakeInteraction({ userId: OTHER, sub, options: { enabled: true, player: 'Alice' } });
    await dispatch(bot, it);
    assert.equal(it.calls[0][0], 'reply');
    assert.match(it.calls[0][1].content, /not allowed/);
  }
  assert.equal(await getSetting(db, 'paused', false), false);
  assert.equal(await getSetting(db, 'maintenance', false), false);
  assert.ok(logger.events.filter((e) => e.type === 'admin.denied').length >= 5);

  // An allowlisted admin calling from another guild is refused too.
  const wrongGuild = fakeInteraction({ userId: ADMIN_ID, guildId: '333333333333333333', sub: 'pause' });
  await dispatch(bot, wrongGuild);
  assert.match(wrongGuild.calls[0][1].content, /not allowed/);
  assert.equal(await getSetting(db, 'paused', false), false);
});

test('administrators can pause; sensitive commands need the same admin to confirm', async () => {
  const { db, bot } = await setup();
  await dispatch(bot, fakeInteraction({ userId: ADMIN_ID, sub: 'pause' }));
  assert.equal(await getSetting(db, 'paused'), true);

  const s = await linking.startLink(db, { discordId: '600000000000000002', mcUsername: 'Alice', settings: S, now: 1 });
  await linking.completeLink(db, { mcUsername: 'Alice', code: s.code, settings: S, checkMembership: member, now: 2 });

  const ask = fakeInteraction({ userId: ADMIN_ID, sub: 'unlink', options: { player: 'Alice' } });
  await dispatch(bot, ask);
  const button = ask.calls[0][1].components[0].toJSON().components[0];
  assert.match(button.custom_id, /^kitbot:confirm:/);
  assert.ok(await linking.getActiveLinkByUsername(db, 'Alice'), 'nothing happens before confirmation');

  const forged = fakeInteraction({ userId: OTHER, customId: button.custom_id });
  await dispatch(bot, forged);
  assert.match(forged.calls[0][1].content, /not allowed/);
  assert.ok(await linking.getActiveLinkByUsername(db, 'Alice'));

  const confirm = fakeInteraction({ userId: ADMIN_ID, customId: button.custom_id });
  await dispatch(bot, confirm);
  assert.match(confirm.calls[0][1].content, /Revoked 1 link/);
  assert.equal(await linking.getActiveLinkByUsername(db, 'Alice'), undefined);
});

test('a member leaving the Discord server loses their link immediately', async () => {
  const { db, logger, bot } = await setup();
  const did = '600000000000000003';
  const s = await linking.startLink(db, { discordId: did, mcUsername: 'Leaver', settings: S, now: 1 });
  await linking.completeLink(db, { mcUsername: 'Leaver', code: s.code, settings: S, checkMembership: member, now: 2 });
  bot.client.emit(Events.GuildMemberRemove, { id: did, guild: { id: GUILD_ID }, user: { tag: 'leaver' } });
  for (let i = 0; i < 50 && (await linking.getActiveLinkByUsername(db, 'Leaver')); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(await linking.getActiveLinkByUsername(db, 'Leaver'), undefined);
  assert.ok(logger.has('discord.member_left'));
  assert.ok(logger.has('link.revoked'));
});

test('/link issues a code bound to the requested username', async () => {
  const { db, bot } = await setup();
  const it = fakeInteraction({ userId: '600000000000000004', command: 'link', options: { minecraft_username: 'Newbie' } });
  await dispatch(bot, it);
  const text = it.calls.find((c) => c[0] === 'editReply')[1];
  const code = /`([A-Z2-9]{4}-[A-Z2-9]{4})`/.exec(text)[1];
  assert.match(text, /\/msg KitBot !link/);
  const done = await linking.completeLink(db, { mcUsername: 'Newbie', code, settings: S, checkMembership: member, now: Date.now() });
  assert.equal(done.ok, true);
});

test('routine Discord reconnects are not posted to the log channel', async () => {
  const { logger, bot } = await setup();
  bot.client.emit(Events.ShardReconnecting, 0);
  bot.client.emit(Events.ShardResume, 0, 1);
  bot.client.emit(Events.ShardDisconnect, {}, 0);
  bot.client.emit(Events.ShardResume, 0, 1);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(logger.events.filter((e) => e.level !== 'DEBUG').map((e) => e.type), []);
});

test('delivery reports are shown as green (delivered) or orange (not confirmed) cards', () => {
  const ok = eventEmbed({ type: 'delivery.report', level: 'INFO', message: '✅ totem kit delivered to Alice\n📍 **1 2 3** (overworld)', created_at: 0 }).toJSON();
  assert.equal(ok.title, '✅ totem kit delivered to Alice');
  assert.equal(ok.color, 0x2ecc71);
  assert.match(ok.description, /1 2 3/);
  const warn = eventEmbed({ type: 'delivery.report', level: 'INFO', message: '⚠️ pvp kit not confirmed for Bob\nx', created_at: 0 }).toJSON();
  assert.equal(warn.color, 0xe67e22);
});
