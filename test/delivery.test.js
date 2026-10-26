'use strict';

// The delivery flow against a simulated Mineflayer bot.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { createDelivery } = require('../src/delivery');
const { DeliveryError } = require('../src/queue');
const { settings, fakeLogger } = require('./helpers');

const HOME = { x: 0, y: 64, z: 0, facing: 'north' };
const station = {
  home: HOME,
  kits: { pvp: { container: { x: 3, y: 64, z: 0 }, standAt: { x: 2, y: 64, z: 0 }, block: 'chest', distance: 3 } }
};

// options: chest (items in the pvp chest), accept (player accepts /tpa), picker (who picks up)
function fakeWorld({ chest = 3, accept = true, picker = 'Steve' } = {}) {
  const bot = new EventEmitter();
  const commands = [];
  let inventory = [];
  let stock = chest;
  bot.username = 'VoidKits';
  bot.health = 20;
  bot.entity = { id: 1, position: new Vec3(0.5, 64, 0.5), yaw: 0, pitch: 0, eyeHeight: 1.62 };
  const steve = { username: 'Steve', entity: { id: 2, position: new Vec3(500, 64, 500), height: 1.8 } };
  bot.players = { Steve: steve, VoidKits: { username: 'VoidKits', entity: bot.entity } };
  bot.inventory = { items: () => inventory, emptySlotCount: () => 36 - inventory.length };
  bot.blockAt = (p) => (p.x === 3 && p.y === 64 && p.z === 0 ? { name: 'chest', position: new Vec3(3, 64, 0) } : { name: 'air', position: p, transparent: true, shapes: [] });
  bot.lookAt = async () => {};
  bot.clearControlStates = () => {};
  bot.closeWindow = () => {};
  bot.pathfinder = {
    setMovements() {},
    stop() {},
    goto: async (goal) => void (bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5))
  };
  const shulker = () => ({ name: 'red_shulker_box', type: 7, count: 1 });
  bot.openContainer = async () => ({
    containerItems: () => Array.from({ length: stock }, shulker),
    withdraw: async () => {
      stock--;
      inventory = [...inventory, shulker()];
    },
    deposit: async () => {
      stock++;
      inventory = inventory.slice(1);
    },
    close() {}
  });
  bot.toss = async () => {
    inventory = inventory.slice(1);
    const item = { id: 99, name: 'item', position: bot.entity.position.clone() };
    bot.emit('entitySpawn', item);
    setTimeout(() => bot.emit('playerCollect', picker === 'Steve' ? steve.entity && { ...steve.entity, username: 'Steve' } : { id: 3, username: picker }, item), 20);
  };
  const sendCommand = async (cmd) => {
    commands.push(cmd);
    if (cmd === '/tpa Steve' && accept) bot.entity.position = steve.entity.position.offset(1, 0, 0); // the bot appears next to Steve
    if (cmd === '/kill') bot.entity.position = new Vec3(1.5, 64, 0.5); // respawn at the base bed
  };
  return { bot, commands, sendCommand, stock: () => stock, inventory: () => inventory };
}

// Stand-in for mineflayer-pathfinder (the simulated bot walks instantly).
const pathfinderLib = {
  Movements: class {},
  goals: {
    GoalNear: class {
      constructor(x, y, z) {
        Object.assign(this, { x, y, z });
      }
    }
  }
};

function service(world, overrides = {}) {
  const s = settings({ delivery: { waitForPlayerMs: 300, pickupTimeoutMs: 300 }, navigation: { respawnWaitMs: 500 }, ...overrides });
  const logger = fakeLogger();
  const stockSeen = [];
  const d = createDelivery({
    getBot: () => world.bot,
    getSettings: () => s,
    getStation: () => station,
    logger,
    sendCommand: world.sendCommand,
    onChatLine: () => () => {},
    onStock: async (kit, left) => void stockSeen.push(left),
    pathfinderLib
  });
  const stages = [];
  const notes = [];
  const ctx = { setStage: async (st) => void stages.push(st), notify: async (m) => void notes.push(m) };
  return { d, logger, stages, notes, ctx, stockSeen };
}

const req = { id: 1, kit: 'pvp', mc_username: 'Steve' };

test('a full delivery: chest, /tpa, throw, pickup confirmed, back home with /kill', async () => {
  const w = fakeWorld();
  const t = service(w);
  await t.d.deliver(req, t.ctx, null);
  assert.deepEqual(t.stages, ['walking', 'taking', 'meeting', 'handoff']);
  assert.deepEqual(w.commands, ['/tpa Steve', '/kill']);
  assert.equal(w.stock(), 2);
  assert.deepEqual(t.stockSeen, [2]);
  assert.match(t.notes[0], /Accept my teleport request/);
  assert.ok(t.logger.events.some((e) => e.type === 'delivery.report' && e.message.startsWith('✅')));
  assert.ok(w.bot.entity.position.distanceTo(new Vec3(0.5, 64, 0.5)) < 2, 'the bot is home');
});

test('the player does not accept: the kit goes back in the chest', async () => {
  const w = fakeWorld({ accept: false });
  const t = service(w);
  await assert.rejects(t.d.deliver(req, t.ctx, null), (e) => e instanceof DeliveryError && /did not accept/.test(e.message) && /does not count/.test(e.playerMessage));
  assert.equal(w.stock(), 3, 'the shulker was put back');
  assert.equal(w.inventory().length, 0);
  assert.ok(!t.stages.includes('handoff'));
});

test('an empty chest: out of stock message', async () => {
  const w = fakeWorld({ chest: 0 });
  const t = service(w);
  await assert.rejects(t.d.deliver(req, t.ctx, null), (e) => /empty/.test(e.message) && /out of stock/.test(e.playerMessage));
  assert.deepEqual(w.commands, []);
});

test('someone else picks the kit up: not a delivery', async () => {
  const w = fakeWorld({ picker: 'Mallory' });
  const t = service(w);
  await assert.rejects(t.d.deliver(req, t.ctx, null), /picked up by Mallory/);
  assert.ok(t.stages.includes('handoff'));
  assert.ok(t.logger.events.some((e) => e.type === 'delivery.report' && e.message.startsWith('⚠️')));
});

test('a lost connection stops the delivery and can be retried', async () => {
  const w = fakeWorld();
  const t = service(w);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(t.d.deliver(req, t.ctx, ac.signal), (e) => e.retryable === true);
});
