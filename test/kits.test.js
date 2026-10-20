'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const kits = require('../src/kits');
const { createQueue } = require('../src/queue');
const limits = require('../src/limits');
const { deepMerge } = require('../src/config');
const { testSettings, sqliteDb, fakeLogger } = require('./helpers');

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('F3 yaw conversion matches Mineflayer conventions', () => {
  close(kits.f3DegreesToYaw(180), 0); // north
  close(kits.f3DegreesToYaw(90), Math.PI / 2); // west
  close(kits.f3DegreesToYaw(0), Math.PI); // south
});

test('directions are relative to the bot orientation', () => {
  const north = kits.homeYaw({ facing: 'north' });
  assert.deepEqual(kits.directionVector(north, 'forward'), { x: 0, z: -1 });
  assert.deepEqual(kits.directionVector(north, 'left'), { x: -1, z: 0 }); // west
  assert.deepEqual(kits.directionVector(north, 'right'), { x: 1, z: 0 }); // east
  assert.deepEqual(kits.directionVector(north, 'backward'), { x: 0, z: 1 }); // south

  const east = kits.homeYaw({ facing: 'east' });
  assert.deepEqual(kits.directionVector(east, 'left'), { x: 0, z: -1 }); // north
  assert.deepEqual(kits.directionVector(east, 'right'), { x: 0, z: 1 }); // south
  assert.deepEqual(kits.directionVector(east, 'backward'), { x: -1, z: 0 }); // west
});

test('default kit placement: totem LEFT, pvp RIGHT, grief BACKWARD', () => {
  const s = testSettings({ navigation: { home: { x: 100, y: 64, z: -200, facing: 'north' } } });
  assert.deepEqual(kits.resolveStandAt(s, 'totem'), { x: 97, y: 64, z: -200 });
  assert.deepEqual(kits.resolveStandAt(s, 'pvp'), { x: 103, y: 64, z: -200 });
  assert.deepEqual(kits.resolveStandAt(s, 'grief'), { x: 100, y: 64, z: -197 });
  s.kits.pvp.standAt = { x: 1, y: 2, z: 3 };
  assert.deepEqual(kits.resolveStandAt(s, 'pvp'), { x: 1, y: 2, z: 3 });
});

test('item matching and missing-item computation', () => {
  const inv = [
    { name: 'red_shulker_box', count: 1 },
    { name: 'totem_of_undying', count: 1 }
  ];
  assert.deepEqual(kits.missingItems(inv, [{ nameRegex: 'shulker_box$', count: 1 }]), []);
  assert.equal(kits.missingItems(inv, [{ name: 'totem_of_undying', count: 3 }])[0].missing, 2);
});

// ---- simulated delivery ----------------------------------------------------

function fakeWorld({ stock = 1, pickup = 'target' } = {}) {
  const bot = new EventEmitter();
  const inventory = [];
  let nextId = 100;
  bot.username = 'KitBot';
  bot.health = 20;
  bot.entity = { id: 1, position: new Vec3(0, 64, 0) };
  bot.registry = { itemsByName: { white_shulker_box: { stackSize: 1 } } };
  bot.inventory = { items: () => inventory.filter((i) => i.count > 0), emptySlotCount: () => 30 };
  const target = { id: 2, username: 'Alice', height: 1.8, position: new Vec3(1, 64, 1) };
  bot.players = { Alice: { username: 'Alice', entity: target } };
  bot.pathfinder = {
    setMovements() {},
    goto: async (goal) => {
      bot.entity.position = new Vec3(goal.x, goal.y, goal.z);
      target.position = bot.entity.position.offset(1, 0, 0);
    },
    stop() {}
  };
  bot.blockAt = (v) => ({ name: 'chest', position: v });
  const chestItems = Array.from({ length: stock }, () => ({ name: 'white_shulker_box', type: 7, count: 1 }));
  bot.openContainer = async () => ({
    containerItems: () => chestItems.filter((i) => i.count > 0),
    withdraw: async (type, meta, count) => {
      const it = chestItems.find((i) => i.type === type && i.count > 0);
      it.count -= count;
      inventory.push({ name: it.name, type, count });
    },
    deposit: async (type, meta, count) => {
      const it = inventory.find((i) => i.type === type && i.count > 0);
      it.count -= count;
      chestItems.push({ name: it.name, type, count });
    },
    close() {}
  });
  bot.lookAt = async () => {};
  bot.look = async () => {};
  bot.toss = async (type, meta, count) => {
    const it = inventory.find((i) => i.type === type && i.count >= count);
    it.count -= count;
    const drop = { id: nextId++, name: 'item', position: bot.entity.position.offset(0, 1, 0) };
    bot.emit('entitySpawn', drop);
    setTimeout(() => {
      if (pickup === 'target') bot.emit('playerCollect', target, drop);
      if (pickup === 'thief') bot.emit('playerCollect', { id: 3, username: 'Thief' }, drop);
    }, 10);
  };
  const fakePathfinder = { Movements: function Movements() {}, goals: { GoalNear: function (x, y, z, r) { Object.assign(this, { x, y, z, r }); } } };
  return { bot, inventory, chestItems, fakePathfinder };
}

async function runDelivery(world, settingsOverride = {}) {
  const s = testSettings(deepMerge({ delivery: { pickupTimeoutMs: 300, waitForPlayerMs: 300 }, navigation: { respawnWaitMs: 300 } }, settingsOverride));
  world.commands = [];
  const db = await sqliteDb();
  const logger = fakeLogger();
  const notices = [];
  const service = kits.createKitService({
    getBot: () => world.bot,
    getSettings: () => s,
    logger,
    sendCommand: async (cmd) => {
      world.commands.push(cmd);
      if (world.onCommand) world.onCommand(cmd);
    },
    onChatLine: () => () => {},
    pathfinderLib: world.fakePathfinder
  });
  const q = createQueue({
    db,
    getSettings: () => s,
    logger,
    canRun: () => true,
    verify: async () => ({ ok: true }),
    deliver: (req, ctx) => service.deliver(req, { ...ctx, notify: async () => {} }, null),
    notify: async (req, msg) => notices.push(msg)
  });
  const r = await limits.reserve(db, { discordId: '100000000000000099', mcUsername: 'Alice', kit: 'totem', limits: s.limits });
  const result = await q.processNext();
  const row = await db.get('SELECT * FROM requests WHERE id = ?', [r.request.id]);
  await db.close();
  return { result, row, notices };
}

test('simulated delivery succeeds only when the target picks the kit up', async () => {
  const world = fakeWorld();
  const { result, row, notices } = await runDelivery(world);
  assert.equal(result, 'delivered');
  assert.equal(row.status, 'delivered');
  assert.match(notices.at(-1), /delivered/);
});

test('simulated delivery: nobody picks it up -> unconfirmed, not delivered', async () => {
  const { result, row, notices } = await runDelivery(fakeWorld({ pickup: 'none' }));
  assert.equal(result, 'unconfirmed');
  assert.equal(row.status, 'unconfirmed');
  assert.ok(!notices.some((n) => /has been delivered/.test(n)));
});

test('simulated delivery: another player grabs it -> unconfirmed, not delivered', async () => {
  const { row } = await runDelivery(fakeWorld({ pickup: 'thief' }));
  assert.equal(row.status, 'unconfirmed');
  assert.match(row.error, /Thief/);
});

test('simulated delivery: empty chest -> failed and refunded with an explanation', async () => {
  const { row, notices } = await runDelivery(fakeWorld({ stock: 0 }));
  assert.equal(row.status, 'failed');
  assert.match(row.error, /out of stock/);
  assert.match(notices.at(-1), /out of stock/);
});

test('simulated delivery: player never arrives -> failed, items returned to the chest', async () => {
  const world = fakeWorld();
  world.bot.players.Alice.entity.position = new Vec3(500, 64, 500);
  world.bot.pathfinder.goto = async (goal) => {
    world.bot.entity.position = new Vec3(goal.x, goal.y, goal.z);
  };
  const { row } = await runDelivery(world);
  assert.equal(row.status, 'failed');
  assert.equal(world.inventory.filter((i) => i.count > 0).length, 0, 'kit put back');
  assert.equal(world.chestItems.filter((i) => i.count > 0).length, 1);
});

// ---- teleport delivery -------------------------------------------------------

const TELEPORT = { delivery: { method: 'teleport', commands: ['/tpa {player}'] } };

function farPlayerWorld({ accepts = true, pickup = 'target', killWorks = true } = {}) {
  const world = fakeWorld({ pickup });
  const target = world.bot.players.Alice.entity;
  // The player stays far from the base; walking never brings the bot near them.
  world.bot.pathfinder.goto = async (goal) => {
    world.bot.entity.position = new Vec3(goal.x, goal.y, goal.z);
  };
  target.position = new Vec3(5000, 70, -3000);
  world.onCommand = (cmd) => {
    if (cmd === '/tpa Alice' && accepts) setTimeout(() => (world.bot.entity.position = target.position.offset(1, 0, 0)), 20);
    if (cmd === '/kill' && killWorks) setTimeout(() => (world.bot.entity.position = new Vec3(1, 64, 1)), 20); // bed next to home
  };
  return world;
}

test('teleport delivery: /tpa to the player, toss, /kill back to base, walk home', async () => {
  const world = farPlayerWorld();
  const { row, notices } = await runDelivery(world, TELEPORT);
  assert.equal(row.status, 'delivered');
  assert.deepEqual(world.commands, ['/tpa Alice', '/kill']);
  assert.deepEqual(world.bot.entity.position, new Vec3(0, 64, 0), 'back on the home block');
  assert.match(notices.at(-1), /delivered/);
});

test('teleport delivery: request not accepted -> kit back in the chest, refunded, no /kill', async () => {
  const world = farPlayerWorld({ accepts: false });
  const { row, notices } = await runDelivery(world, TELEPORT);
  assert.equal(row.status, 'failed');
  assert.match(row.error, /did not accept the teleport request/);
  assert.match(notices.at(-1), /did not accept my teleport request in time/);
  assert.deepEqual(world.commands, ['/tpa Alice'], 'still at base, so no /kill');
  assert.equal(world.chestItems.filter((i) => i.count > 0).length, 1, 'kit returned to the chest');
});

test('teleport delivery: kit thrown but not picked up -> unconfirmed, still returns to base', async () => {
  const world = farPlayerWorld({ pickup: 'none' });
  const { row } = await runDelivery(world, TELEPORT);
  assert.equal(row.status, 'unconfirmed');
  assert.deepEqual(world.commands, ['/tpa Alice', '/kill']);
});

test('a bot stranded away from base returns before fetching the next kit', async () => {
  const world = farPlayerWorld();
  world.bot.entity.position = new Vec3(9000, 64, 9000);
  const { row } = await runDelivery(world, TELEPORT);
  assert.equal(row.status, 'delivered');
  assert.deepEqual(world.commands, ['/kill', '/tpa Alice', '/kill']);
});

test('if /kill does not bring the bot back, the order fails safely and an error is logged', async () => {
  const world = farPlayerWorld({ killWorks: false });
  world.bot.entity.position = new Vec3(9000, 64, 9000);
  const { row } = await runDelivery(world, TELEPORT);
  assert.equal(row.status, 'failed');
  assert.match(row.error, /away from its base/);
});
