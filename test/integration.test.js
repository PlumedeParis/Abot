'use strict';

// End to end over the real Minecraft 1.21.11 protocol: a local server
// (minecraft-protocol) with AuthMe-style /reg and /log, the 1b1t.cc chat
// format, real player chat packets, and the real Mineflayer-based bot.

const test = require('node:test');
const assert = require('node:assert/strict');
const mc = require('minecraft-protocol');
const nbt = require('prismarine-nbt');
const mcData = require('minecraft-data')('1.21.11');
const { createMinecraftBot } = require('../src/minecraft');
const linking = require('../src/linking');
const { settings, sqliteDb, fakeLogger, member, waitFor } = require('./helpers');

const STEVE = '11111111-2222-3333-4444-555555555555';

function startServer(port) {
  const server = mc.createServer({ 'online-mode': false, version: '1.21.11', port, hideErrors: true });
  const commands = [];
  const chats = [];
  const clients = [];
  const system = (c, text) => c.write('system_chat', { content: nbt.comp({ text: nbt.string(text) }), isActionBar: false });
  const playerChat = (c, uuid, name, message) =>
    c.write('player_chat', {
      globalIndex: 0,
      senderUuid: uuid,
      index: 0,
      signature: undefined,
      plainMessage: message,
      timestamp: BigInt(Date.now()),
      salt: 0n,
      previousMessages: [],
      unsignedChatContent: undefined,
      filterType: 0,
      type: { chatType: 0 },
      networkName: nbt.comp({ text: nbt.string(name) }),
      networkTargetName: undefined
    });
  server.on('playerJoin', (c) => {
    clients.push(c);
    const lp = { ...mcData.loginPacket };
    delete lp.dimensionCodec;
    c.write('login', { ...lp, entityId: c.id, enforcesSecureChat: false });
    c.write('update_health', { health: 20, food: 20, foodSaturation: 5 });
    c.write('position', { teleportId: 1, x: 0, y: 64, z: 0, dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, flags: {} });
    c.write('player_info', { action: { add_player: true, update_listed: true }, data: [{ uuid: STEVE, player: { name: 'Steve', properties: [] }, listed: 1 }] });
    setTimeout(() => system(c, 'Please register with /reg <password> <password>'), 200);
    c.on('chat_command', ({ command }) => {
      commands.push(command);
      if (command.startsWith('reg ')) system(c, 'Successfully registered!');
    });
    c.on('chat_message', ({ message }) => chats.push(message));
  });
  return {
    commands,
    chats,
    system: (text) => clients.forEach((c) => system(c, text)),
    playerChat: (uuid, name, msg) => clients.forEach((c) => playerChat(c, uuid, name, msg)),
    join: (uuid, name) => clients.forEach((c) => c.write('player_info', { action: { add_player: true, update_listed: true }, data: [{ uuid, player: { name, properties: [] }, listed: 1 }] })),
    ready: new Promise((r) => server.on('listening', r)),
    close: () => server.close()
  };
}

test('VoidKits logs in and answers !kit and !link in the 1b1t chat format', { timeout: 60000 }, async () => {
  const port = 25000 + Math.floor(Math.random() * 2000);
  const srv = startServer(port);
  await srv.ready;
  const db = await sqliteDb();
  const logger = fakeLogger();
  const s = settings({ chat: { minDelayMs: 50, perPlayerCommandIntervalMs: 0, welcome: { joinGraceSeconds: 0.5 } }, auth: { postLoginDelayMs: 50, promptTimeoutMs: 3000 } });
  const secrets = { minecraft: { host: '127.0.0.1', port, username: 'VoidKits', auth: 'offline', password: 'Plume2', version: '1.21.11' }, discord: {}, database: {} };
  const bot = createMinecraftBot({ config: { settings: s, secrets }, db, logger, checkMembership: member });
  const sent = (prefix) => srv.commands.some((c) => c.startsWith(prefix));
  try {
    await bot.start();
    // First join: /reg with the password, then ready.
    assert.ok(await waitFor(() => sent('reg Plume2 Plume2')), `commands: ${JSON.stringify(srv.commands)}`);
    assert.ok(await waitFor(() => bot.runtime.ready), 'the bot became ready');

    // The exact 1b1t.cc format (system message, rank of several words).
    srv.system('OG 1b1ter Steve » !kit pvp');
    assert.ok(await waitFor(() => sent('msg Steve Link your account first')), `commands: ${JSON.stringify(srv.commands)}`);

    // Messages relayed from Discord are not commands.
    srv.system('[1b1tDiscord] OG 1b1ter Steve » !kit totem');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(srv.commands.filter((c) => c.startsWith('msg Steve')).length, 1);

    // A real player chat packet (vanilla chat or /msg) with the link code.
    const { code } = await linking.startLink(db, { discordId: '111111111111111111', name: 'Steve', settings: s });
    srv.playerChat(STEVE, 'Steve', `!link ${code}`);
    assert.ok(await waitFor(() => sent('msg Steve Linked to your Discord account')), `commands: ${JSON.stringify(srv.commands)}`);
    const link = await linking.activeLinkByUsername(db, 'Steve');
    assert.equal(link.mc_uuid, STEVE, 'linked with the UUID from the packet');

    // Linked now: the order is understood; this flat test world has no kit chests.
    srv.playerChat(STEVE, 'Steve', '!kit pvp');
    assert.ok(await waitFor(() => sent('msg Steve The kit bot is not set up yet')), `commands: ${JSON.stringify(srv.commands)}`);
    // The station search waits up to 15s for chunks (this server sends none).
    assert.ok(await waitFor(() => logger.events.some((e) => e.type === 'station.missing'), 25000));
    assert.ok(logger.events.some((e) => e.type === 'chat.command' && e.message === 'Steve: !kit pvp'));

    // A player joining gets a private message, but only while deliveries are
    // possible: this test world has no kit chests, so nothing is sent.
    await new Promise((r) => setTimeout(r, 700)); // after the start-up grace period
    srv.join('aaaaaaaa-2222-3333-4444-555555555555', 'Newbie');
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!sent('msg Newbie'), 'no welcome while the kit chests are missing');
    bot.runtime.stationReady = true;
    srv.join('bbbbbbbb-2222-3333-4444-555555555555', 'Alex');
    assert.ok(await waitFor(() => sent('msg Alex order a free kit by doing !kit totem/pvp/grief')), `commands: ${JSON.stringify(srv.commands)}`);
    bot.runtime.stationReady = false;

    // Nobody can order for a player who is not in the tab list.
    srv.system('Ghost » !kit pvp');
    assert.ok(await waitFor(() => logger.events.some((e) => e.type === 'chat.unreadable' && e.message.includes('Ghost'))));
    assert.ok(!sent('msg Ghost'));
    assert.ok(srv.commands.every((c) => !c.includes('undefined')));
  } finally {
    await bot.stop();
    srv.close();
    await db.close();
  }
});
