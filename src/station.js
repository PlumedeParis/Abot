'use strict';

// Kit station auto-detection.
// When navigation.home is not configured, the bot treats the block it stands
// on after login as home and the direction it faces (snapped to north, south,
// east or west) as its orientation. It then looks along each kit's direction
// (totem left, pvp right, grief behind) for the first chest, barrel or
// shulker box within scanDistance blocks, at foot level, one block up or one
// block down. The detected layout is stored in the database and reused on
// later logins, so the bot does not need to be at home when it reconnects.

const { directionVector, f3DegreesToYaw } = require('./kits');
const { FACINGS, deepMerge } = require('./config');

const CONTAINER_RE = /(^|_)(chest|barrel|shulker_box)$/;

// Mineflayer yaw -> nearest cardinal direction name.
function facingFromYaw(yaw) {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  if (Math.abs(fx) > Math.abs(fz)) return fx > 0 ? 'east' : 'west';
  return fz > 0 ? 'south' : 'north';
}

// blockAt({x, y, z}) -> { name } | null
function detectStation({ position, yaw, blockAt, kits, scanDistance = 6 }) {
  const home = { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) };
  const facing = facingFromYaw(yaw);
  const cardinalYaw = f3DegreesToYaw(FACINGS[facing]);
  const found = {};
  const missing = [];
  const used = new Set();

  for (const [name, kit] of Object.entries(kits)) {
    const v = directionVector(cardinalYaw, kit.direction);
    const step = { x: Math.round(v.x), z: Math.round(v.z) };
    let hit = null;
    for (let d = 1; d <= scanDistance && !hit; d++) {
      for (const dy of [0, 1, -1]) {
        const pos = { x: home.x + step.x * d, y: home.y + dy, z: home.z + step.z * d };
        const key = `${pos.x},${pos.y},${pos.z}`;
        const block = blockAt(pos);
        if (block && CONTAINER_RE.test(block.name) && !used.has(key)) {
          used.add(key);
          hit = { container: pos, distance: d, block: block.name };
          break;
        }
      }
    }
    if (!hit) {
      missing.push(name);
      continue;
    }
    // Stand on the block just before the chest (home itself if it is adjacent).
    const back = hit.distance - 1;
    found[name] = {
      direction: kit.direction,
      distance: hit.distance,
      block: hit.block,
      standAt: { x: home.x + step.x * back, y: home.y, z: home.z + step.z * back },
      container: hit.container
    };
  }
  return { ok: missing.length === 0, home: { ...home, facing }, kits: found, missing };
}

// Returns a copy of settings with the detected station filled in. Values the
// user configured explicitly always win.
function applyStation(settings, station) {
  const kits = {};
  for (const [name, k] of Object.entries(station.kits)) {
    const configured = settings.kits[name] || {};
    kits[name] = {
      standAt: configured.standAt || k.standAt,
      retrieval: { container: (configured.retrieval && configured.retrieval.container) || k.container }
    };
  }
  return deepMerge(settings, { navigation: { home: settings.navigation.home || station.home }, kits });
}

function describeStation(station) {
  const parts = Object.entries(station.kits).map(([n, k]) => `${n}: ${k.block} ${k.distance} block(s) ${k.direction === 'backward' ? 'behind' : `to the ${k.direction}`}`);
  return `facing ${station.home.facing}; ${parts.join('; ')}`;
}

module.exports = { detectStation, applyStation, describeStation, facingFromYaw, CONTAINER_RE };
