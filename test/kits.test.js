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

test('default kit placement: totem LEFT, pvp RIGHT, grief IN FRONT', () => {
  const s = testSettings({ navigation: { home: { x: 100, y: 64, z: -200, facing: 'north' } } });
  assert.deepEqual(kits.resolveStandAt(s, 'totem'), { x: 97, y: 64, z: -200 });
  assert.deepEqual(kits.resolveStandAt(s, 'pvp'), { x: 103, y: 64, z: -200 });
  assert.deepEqual(kits.resolveStandAt(s, 'grief'), { x: 100, y: 64, z: -203 });
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
  bot.closeWindow = () => {};
  bot.openCalls = [];
  bot.openContainer = async (block, direction, cursor) => {
    bot.openCalls.push({ direction, cursor });
    if (bot.ignoreClicks && bot.ignoreClicks-- > 0) return new Promise(() => {}); // server ignores the click
    return openWindow();
  };
  const openWindow = () => ({
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
  const fakePathfinder = {
    Movements: function Movements() {},
    goals: {
      GoalNear: function (x, y, z, r) {
        Object.assign(this, { x, y, z, r });
      },
      GoalBlock: function (x, y, z) {
        Object.assign(this, { x: x + 0.5, y, z: z + 0.5 });
      }
    }
  };
  return { bot, inventory, chestItems, fakePathfinder };
}

let lastLogger = null;
let lastStock = [];
async function runDelivery(world, settingsOverride = {}) {
  lastStock = [];
  const s = testSettings(deepMerge({ delivery: { pickupTimeoutMs: 300, waitForPlayerMs: 300 }, navigation: { respawnWaitMs: 300, chestOpenTimeoutMs: 200 } }, settingsOverride));
  world.commands = [];
  const db = await sqliteDb();
  const logger = fakeLogger();
  lastLogger = logger;
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
    pathfinderLib: world.fakePathfinder,
    onStock: async (kit, left) => lastStock.push([kit, left])
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

test('teleport delivery posts a location report (Discord only) with nearby containers', async () => {
  const world = farPlayerWorld();
  const bot = world.bot;
  bot.game = { dimension: 'minecraft:the_nether' };
  bot.registry.blocksArray = [
    { id: 1, name: 'chest' },
    { id: 2, name: 'red_shulker_box' },
    { id: 3, name: 'barrel' }
  ];
  const placed = { '5001,70,-3000': 'chest', '5002,70,-3000': 'chest', '5003,71,-3000': 'red_shulker_box' };
  bot.findBlocks = () => Object.keys(placed).map((k) => new Vec3(...k.split(',').map(Number)));
  bot.blockAt = (v) => ({ name: placed[`${v.x},${v.y},${v.z}`] || 'chest', position: v });
  bot.entities = {
    9: { id: 9, type: 'player', username: 'Bob', position: new Vec3(5004, 70, -3000) },
    10: { id: 10, name: 'item', position: new Vec3(5001, 70, -2999), getDroppedItem: () => ({ name: 'blue_shulker_box', count: 2 }) }
  };
  const { row } = await runDelivery(world, TELEPORT);
  assert.equal(row.status, 'delivered');
  assert.ok(lastLogger.events.some((e) => e.type === 'delivery.teleported' && !e.details), 'short line in the log channel');
  const evt = lastLogger.events.find((e) => e.type === 'delivery.report');
  assert.ok(evt, 'report logged');
  assert.ok(!/5001|-3000/.test(evt.message), 'no coordinates in the console part');
  assert.match(evt.details, /\*\*5001 70 -3000\*\* \(the_nether\)/);
  assert.match(evt.details, /2 chest\(s\).*1 shulker box\(es\) placed/);
  assert.match(evt.details, /on the ground: 2/);
  assert.match(evt.details, /Other players nearby: Bob/);
  assert.match(evt.details, /Kit: \*\*totem\*\* for \*\*Alice\*\*/);
  assert.match(evt.message, /^✅ totem kit delivered to Alice$/);
  assert.match(evt.details, /Picked up by the player/);
});

// ---- opening chests -----------------------------------------------------------

test('the bot clicks the side of the chest that faces it, like a player', () => {
  const bot = { entity: { position: new Vec3(100.5, 64, 200.5), eyeHeight: 1.62 } };
  // Totem chest directly west of the bot (same level): click its east face.
  let f = kits.clickFace(bot, { position: new Vec3(99, 64, 200) });
  assert.deepEqual(f.direction, new Vec3(1, 0, 0));
  assert.deepEqual(f.cursor, new Vec3(1, 0.5, 0.5));
  // Grief chest two blocks north: click its south face.
  f = kits.clickFace(bot, { position: new Vec3(100, 64, 198) });
  assert.deepEqual(f.direction, new Vec3(0, 0, 1));
  assert.deepEqual(f.cursor, new Vec3(0.5, 0.5, 1));
  // Chest right below the bot: click its top.
  f = kits.clickFace(bot, { position: new Vec3(100, 63, 200) });
  assert.deepEqual(f.direction, new Vec3(0, 1, 0));
});

test('if the server ignores the first click, the bot retries and still delivers', async () => {
  const world = fakeWorld();
  world.bot.ignoreClicks = 1;
  const { row } = await runDelivery(world);
  assert.equal(row.status, 'delivered');
  assert.equal(world.bot.openCalls.length, 2);
  assert.deepEqual(world.bot.openCalls[1].direction, world.bot.openCalls[0].direction, 'second try: same side');
  assert.ok(world.bot.openCalls[1].cursor.y > world.bot.openCalls[0].cursor.y, 'second try: a bit higher on that side');
});

test('delivery report: "not confirmed" when the kit was thrown but not picked up', async () => {
  const world = farPlayerWorld({ pickup: 'none' });
  await runDelivery(world, TELEPORT);
  const evt = lastLogger.events.find((e) => e.type === 'delivery.report');
  assert.match(evt.message, /^⚠️ totem kit not confirmed for Alice$/);
  assert.match(evt.details, /Pickup not confirmed: player did not pick up the kit in time/);
});

test('no delivery report when the kit never left the bot', async () => {
  const world = farPlayerWorld({ accepts: false });
  await runDelivery(world, TELEPORT);
  assert.ok(!lastLogger.events.some((e) => e.type === 'delivery.report'));
});

test('delivery announcement text', () => {
  const { deliveryAnnouncement } = require('../src/minecraft');
  const { DEFAULTS } = require('../src/config');
  assert.equal(
    deliveryAnnouncement(DEFAULTS.chat.deliveryAnnouncement, { mc_username: 'Steve', kit: 'totem' }),
    'Steve just received a totem kit. Order one yourself by doing !kit totem/pvp/grief'
  );
  assert.equal(deliveryAnnouncement('', { mc_username: 'Steve', kit: 'totem' }), '');
});

test('the kits left in the chest are counted each time it is opened', async () => {
  await runDelivery(fakeWorld({ stock: 3 }));
  assert.deepEqual(lastStock, [['totem', 2]]);
  await runDelivery(fakeWorld({ stock: 0 }));
  assert.deepEqual(lastStock, [['totem', 0]], 'out of stock is recorded too');
});

test('block interactions get increasing sequence numbers like a real client', () => {
  const sent = [];
  const client = { write: (name, params) => sent.push([name, params]) };
  kits.numberBlockInteractions(client);
  client.write('block_place', { sequence: 0, hand: 0 });
  client.write('position', { x: 1 });
  client.write('block_place', { sequence: 0, hand: 0 });
  client.write('use_item', { sequence: 0, hand: 0 });
  assert.deepEqual(sent.map(([n, p]) => [n, p.sequence]), [['block_place', 1], ['position', undefined], ['block_place', 2], ['use_item', 3]]);
});

test('opening a chest does not re-aim at the block centre', async () => {
  const calls = [];
  const bot = {
    lookAt: async (p) => calls.push(['lookAt', p]),
    // Like mineflayer: openContainer -> activateBlock -> bot.lookAt(centre) synchronously.
    openContainer(block, direction, cursor) {
      this.lookAt(block.position.offset(0.5, 0.5, 0.5));
      calls.push(['click', direction, cursor]);
      return Promise.resolve('window');
    }
  };
  const w = await kits.openWithoutReaim(bot, { position: new Vec3(0, 0, 0) }, new Vec3(1, 0, 0), new Vec3(1, 0.5, 0.5));
  assert.equal(w, 'window');
  assert.deepEqual(calls.map((c) => c[0]), ['click']);
  await bot.lookAt('restored');
  assert.deepEqual(calls.at(-1), ['lookAt', 'restored']);
});

test('the bot looks at the exact point it clicks before opening the chest', async () => {
  const world = fakeWorld();
  const looks = [];
  world.bot.lookAt = async (p) => looks.push(p);
  const { row } = await runDelivery(world);
  assert.equal(row.status, 'delivered');
  const click = world.bot.openCalls[0];
  // Totem chest at (-4,64,0), bot standing at (-3,64,0): east face, point (-3, 64.5, 0.5).
  assert.deepEqual(click.direction, new Vec3(1, 0, 0));
  assert.ok(looks.some((p) => p.x === -3 && p.y === 64.5 && p.z === 0.5), JSON.stringify(looks));
});

test('a chest with a solid block on top (either half) is reported instead of clicked in vain', () => {
  const reg = require('prismarine-registry')('1.21.11');
  const Block = require('prismarine-block')(reg);
  const make = (name, props) => {
    const b = Block.fromStateId(reg.blocksByName[name].defaultState, 0);
    if (props) {
      // Find the state id of a chest with these properties.
      const min = reg.blocksByName[name].minStateId;
      const max = reg.blocksByName[name].maxStateId;
      for (let id = min; id <= max; id++) {
        const c = Block.fromStateId(id, 0);
        const p = c.getProperties();
        if (Object.entries(props).every(([k, v]) => p[k] === v)) return c;
      }
    }
    return b;
  };
  // Double chest facing east (opening towards the bot at x=100), halves at z=200 and z=201.
  const chest = make('chest', { facing: 'east', type: 'left', waterlogged: false });
  chest.position = new Vec3(99, 64, 200);
  const partner = make('chest', { facing: 'east', type: 'right', waterlogged: false });
  const world = { '99,64,201': partner, '99,65,201': make('obsidian') };
  const bot = { blockAt: (v) => world[`${v.x},${v.y},${v.z}`] || make('air'), entities: {} };
  assert.deepEqual(kits.chestBlockers(bot, chest), ['a obsidian block is on top of the other half']);
  world['99,65,201'] = make('glass');
  world['99,65,200'] = make('oak_slab');
  assert.deepEqual(kits.chestBlockers(bot, chest), [], 'glass and slabs do not block');
  bot.entities = { 5: { name: 'cat', position: new Vec3(99.5, 64.9, 200.5) } };
  assert.deepEqual(kits.chestBlockers(bot, chest), ['a cat is sitting on the half the bot uses']);
});

test('the bot keeps trying like a player: looks away, steps back in front of the chest, clicks again', async () => {
  const world = fakeWorld();
  world.bot.ignoreClicks = 5; // the server ignores the first five clicks
  const looks = [];
  world.bot.look = async (yaw, pitch) => looks.push({ yaw, pitch });
  const gotos = [];
  const goto = world.bot.pathfinder.goto;
  world.bot.pathfinder.goto = async (goal) => {
    gotos.push(goal);
    return goto(goal);
  };
  const { row } = await runDelivery(world);
  assert.equal(row.status, 'delivered', 'opened on the 6th try');
  assert.equal(world.bot.openCalls.length, 6);
  assert.equal(looks.length, 5, 'looked away after each failed try');
  assert.deepEqual(world.bot.openCalls.map((c) => c.direction.y), [0, 0, 1, 0, 0, 1], 'side, side higher, top, ...');
  // Totem spot is (-3,64,0): the bot steps onto its centre before trying.
  assert.ok(gotos.some((g) => g.x === -2.5 && g.z === 0.5));
});

test('after every try fails, the error says how many tries and why', async () => {
  const world = fakeWorld();
  world.bot.ignoreClicks = 99;
  const { row } = await runDelivery(world, { navigation: { chestOpenAttempts: 3 } });
  assert.equal(row.status, 'failed');
  assert.match(row.error, /after 3 tries \(no chest window opened x3\)/);
});
