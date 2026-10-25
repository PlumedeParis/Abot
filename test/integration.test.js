'use strict';

// End-to-end over the real Minecraft 1.21.11 protocol: a local fake server
// (minecraft-protocol) with AuthMe-style /reg and /log, and the real
// Mineflayer-based bot. No internet access needed.

const test = require('node:test');
const assert = require('node:assert/strict');
const mc = require('minecraft-protocol');
const nbt = require('prismarine-nbt');
const mcData = require('minecraft-data')('1.21.11');
const { createMinecraftBot } = require('../src/minecraft');
const linking = require('../src/linking');
const { sqliteDb, testSettings, fakeLogger, member } = require('./helpers');

function startFakeServer({ port, registered }) {
  const commands = [];
  const chats = [];
  const server = mc.createServer({ 'online-mode': false, version: '1.21.11', port, hideErrors: true });
  const clients = [];
  const say = (client, text) => client.write('system_chat', { content: nbt.comp({ text: nbt.string(text) }), isActionBar: false });
  server.on('playerJoin', (client) => {
    clients.push(client);
    const lp = { ...mcData.loginPacket };
    delete lp.dimensionCodec;
    client.write('login', { ...lp, entityId: client.id, enforcesSecureChat: false });
    client.write('update_health', { health: 20, food: 20, foodSaturation: 5 });
    client.write('position', { teleportId: 1, x: 0, y: 64, z: 0, dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, flags: {} });
    setTimeout(() => say(client, registered ? 'Please login with /login <password>' : 'Please register with /reg <password> <password>'), 200);
    client.on('chat_command', ({ command }) => {
      commands.push(command);
      if (command.startsWith('reg ')) say(client, 'Successfully registered!');
      if (command.startsWith('log ')) say(client, 'Successful login!');
    });
    client.on('chat_message', ({ message }) => chats.push(message));
  });
  return {
    commands,
    chats,
    say: (text) => clients.forEach((c) => say(c, text)),
    addPlayer: (name, uuid) =>
      clients.forEach((c) =>
        c.write('player_info', { action: { add_player: true, update_listed: true }, data: [{ uuid, player: { name, properties: [] }, listed: 1 }] })
      ),
    ready: new Promise((r) => server.on('listening', r)),
    close: () => server.close()
  };
}

const waitFor = async (fn, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

test('real protocol: /reg on first join, /log afterwards, chat commands and link', { timeout: 60000 }, async () => {
  const db = await sqliteDb();
  const settings = testSettings({ auth: { postLoginDelayMs: 0 }, chat: { minDelayMs: 20, perPlayerCommandIntervalMs: 0 } });
  const secrets = {
    minecraft: { host: '127.0.0.1', port: 25611, username: 'KitBot', auth: 'offline', password: 'Sup3rSecretPw', version: '1.21.11' },
    discord: { token: 'x', guildId: '222222222222222222', adminIds: [] },
    database: {}
  };
  const logger = fakeLogger();

  // First join: unregistered account.
  let srv = startFakeServer({ port: 25611, registered: false });
  await srv.ready;
  let bot = createMinecraftBot({ config: { settings, secrets }, db, logger, checkMembership: member });
  await bot.start();
  assert.ok(await waitFor(() => bot.runtime.minecraftReady), 'bot became ready');
  assert.deepEqual(srv.commands, ['reg Sup3rSecretPw Sup3rSecretPw']);
  await bot.stop();
  srv.close();

  // Second join: the account is registered, so the bot logs in.
  srv = startFakeServer({ port: 25612, registered: true });
  await srv.ready;
  secrets.minecraft.port = 25612;
  bot = createMinecraftBot({ config: { settings, secrets }, db, logger, checkMembership: member });
  await bot.start();
  assert.ok(await waitFor(() => bot.runtime.minecraftReady));
  assert.equal(srv.commands[0], 'log Sup3rSecretPw');

  srv.addPlayer('Alice', '11111111-2222-3333-4444-555555555555');
  await new Promise((r) => setTimeout(r, 200));
  srv.say('<Alice> hello everyone');
  srv.say('<Alice> !kit sword');
  assert.ok(await waitFor(() => srv.commands.includes('msg Alice Unknown kit. Available kits: totem, pvp, grief.')));

  // Link through the in-game whisper, then request a kit.
  const code = await linking.startLink(db, { discordId: '500000000000000009', mcUsername: 'Alice', settings, now: Date.now() });
  srv.say(`Alice whispers: !link ${code.code}`);
  assert.ok(await waitFor(async () => !!(await linking.getActiveLinkByUsername(db, 'Alice'))));
  const link = await linking.getActiveLinkByUsername(db, 'Alice');
  assert.equal(link.mc_uuid, '11111111-2222-3333-4444-555555555555');

  await db.run("INSERT INTO settings (key, value, updated_at) VALUES ('paused', 'true', 0) ON CONFLICT (key) DO UPDATE SET value = 'true'");
  await new Promise((r) => setTimeout(r, 3500)); // runtime refresh interval
  srv.say('<Alice> !kit totem');
  assert.ok(await waitFor(() => srv.commands.some((c) => c.startsWith('msg Alice Kit deliveries are paused'))));

  // A spoofed whisper typed by another player is attributed to that player and ignored.
  srv.say('<Mallory> Alice whispers: !kit pvp');
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(!srv.commands.some((c) => c.startsWith('msg Mallory')));
  assert.ok(srv.commands.every((c) => !c.includes('undefined')));

  // A command in a chat format the patterns do not know is reported with the raw line.
  srv.say('* Alice says !kit totem');
  assert.ok(await waitFor(() => logger.events.some((e) => e.type === 'chat.unreadable' && e.message.includes('* Alice says !kit totem'))));
  // A command from a name that is not in the tab list is ignored, and the log says why.
  srv.say('<Ghost> !kit totem');
  assert.ok(await waitFor(() => logger.events.some((e) => e.type === 'request.ignored' && e.message.includes('Ghost'))));

  // An admin message queued from Discord (/kitbot say) appears in the public chat.
  const { createAdminActions } = require('../src/admin');
  const actions = createAdminActions({ db, logger, getSettings: () => settings });
  assert.equal((await actions.say({ id: '111111111111111111', tag: 'admin' }, '/kill')).reason, 'command');
  assert.equal((await actions.say({ id: '111111111111111111', tag: 'admin' }, 'Kits are back!\nJoin our Discord')).ok, true);
  assert.ok(await waitFor(() => srv.chats.includes('Kits are back! Join our Discord'), 8000), `chat: ${JSON.stringify(srv.chats)}`);

  await bot.stop();
  srv.close();
  await db.close();
});
