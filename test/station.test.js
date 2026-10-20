'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectStation, applyStation, describeStation, facingFromYaw } = require('../src/station');
const { f3DegreesToYaw, resolveStandAt } = require('../src/kits');
const { DEFAULTS, validateSettings, resolveDelivery, deepMerge } = require('../src/config');

const world = (blocks) => (p) => {
  const name = blocks[`${p.x},${p.y},${p.z}`];
  return name ? { name } : { name: 'air' };
};

test('facing is snapped to the nearest cardinal direction', () => {
  assert.equal(facingFromYaw(f3DegreesToYaw(180)), 'north');
  assert.equal(facingFromYaw(f3DegreesToYaw(0)), 'south');
  assert.equal(facingFromYaw(f3DegreesToYaw(90)), 'west');
  assert.equal(facingFromYaw(f3DegreesToYaw(-90)), 'east');
  assert.equal(facingFromYaw(f3DegreesToYaw(170)), 'north');
  assert.equal(facingFromYaw(f3DegreesToYaw(-100)), 'east');
});

test('finds totem LEFT, pvp RIGHT and grief BEHIND relative to the facing', () => {
  // Bot at (100.5, 64, 200.5) facing north: left = west (-x), right = east (+x), behind = south (+z).
  const r = detectStation({
    position: { x: 100.5, y: 64, z: 200.5 },
    yaw: f3DegreesToYaw(175),
    blockAt: world({ '97,64,200': 'chest', '102,65,200': 'barrel', '100,64,201': 'trapped_chest' }),
    kits: DEFAULTS.kits
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.home, { x: 100, y: 64, z: 200, facing: 'north' });
  assert.deepEqual(r.kits.totem.container, { x: 97, y: 64, z: 200 });
  assert.deepEqual(r.kits.totem.standAt, { x: 98, y: 64, z: 200 });
  assert.deepEqual(r.kits.pvp.container, { x: 102, y: 65, z: 200 });
  assert.deepEqual(r.kits.grief.container, { x: 100, y: 64, z: 201 });
  assert.deepEqual(r.kits.grief.standAt, { x: 100, y: 64, z: 200 }, 'adjacent chest: stand at home');
  assert.match(describeStation(r), /totem: chest 3 block\(s\) to the left/);
});

test('works for other facings (east)', () => {
  // Facing east: left = north (-z), right = south (+z), behind = west (-x).
  const r = detectStation({
    position: { x: 0.5, y: 70, z: 0.5 },
    yaw: f3DegreesToYaw(-90),
    blockAt: world({ '0,70,-2': 'chest', '0,70,2': 'chest', '-2,70,0': 'white_shulker_box' }),
    kits: DEFAULTS.kits
  });
  assert.equal(r.ok, true);
  assert.equal(r.home.facing, 'east');
  assert.deepEqual(r.kits.totem.container, { x: 0, y: 70, z: -2 });
  assert.deepEqual(r.kits.pvp.container, { x: 0, y: 70, z: 2 });
  assert.deepEqual(r.kits.grief.container, { x: -2, y: 70, z: 0 });
});

test('reports which chests are missing and ignores non-containers', () => {
  const r = detectStation({
    position: { x: 0, y: 64, z: 0 },
    yaw: f3DegreesToYaw(180),
    blockAt: world({ '-3,64,0': 'chest', '3,64,0': 'chest_boat', '0,64,9': 'chest' }),
    kits: DEFAULTS.kits,
    scanDistance: 6
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['pvp', 'grief']);
});

test('applying a detected station makes the settings complete and valid', () => {
  const r = detectStation({
    position: { x: 100, y: 64, z: 200 },
    yaw: f3DegreesToYaw(180),
    blockAt: world({ '96,64,200': 'chest', '104,64,200': 'chest', '100,64,204': 'chest' }),
    kits: DEFAULTS.kits
  });
  const s = applyStation(deepMerge(DEFAULTS, { server: { botsAllowedConfirmed: true } }), r);
  assert.deepEqual(validateSettings(s), []);
  assert.deepEqual(resolveStandAt(s, 'totem'), { x: 97, y: 64, z: 200 });
  assert.deepEqual(resolveDelivery(s, 'pvp').dropoff, { x: 100, y: 64, z: 200 }, 'drop-off defaults to home');
});

test('explicitly configured coordinates win over detection', () => {
  const configured = deepMerge(DEFAULTS, { kits: { pvp: { retrieval: { container: { x: 1, y: 2, z: 3 } } } } });
  const r = detectStation({
    position: { x: 0, y: 64, z: 0 },
    yaw: f3DegreesToYaw(180),
    blockAt: world({ '-2,64,0': 'chest', '2,64,0': 'chest', '0,64,2': 'chest' }),
    kits: DEFAULTS.kits
  });
  assert.deepEqual(applyStation(configured, r).kits.pvp.retrieval.container, { x: 1, y: 2, z: 3 });
});

test('the bot does not need to face the right way: the only matching orientation is used', async () => {
  // Real layout facing north: totem west (-x), pvp east (+x), grief south (+z); nothing in front (north).
  const blocks = world({ '97,64,200': 'chest', '103,64,200': 'barrel', '100,64,203': 'chest' });
  for (const deg of [0, 90, -90]) {
    const r = detectStation({ position: { x: 100.5, y: 64, z: 200.5 }, yaw: f3DegreesToYaw(deg), blockAt: blocks, kits: DEFAULTS.kits });
    assert.equal(r.ok, true, `bot facing F3 ${deg}`);
    assert.equal(r.home.facing, 'north');
    assert.deepEqual(r.kits.totem.container, { x: 97, y: 64, z: 200 });
    assert.deepEqual(r.kits.pvp.container, { x: 103, y: 64, z: 200 });
    assert.equal(r.facingCorrected, true);
  }
});

test('with containers on all four sides, the bot\'s own facing decides', async () => {
  const blocks = world({ '97,64,200': 'chest', '103,64,200': 'chest', '100,64,203': 'chest', '100,64,197': 'barrel' });
  const r = detectStation({ position: { x: 100.5, y: 64, z: 200.5 }, yaw: f3DegreesToYaw(0), blockAt: blocks, kits: DEFAULTS.kits });
  assert.equal(r.ok, true);
  assert.equal(r.home.facing, 'south');
  assert.equal(r.facingCorrected, undefined);
});
