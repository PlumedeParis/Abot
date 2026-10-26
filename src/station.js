'use strict';

// The kit station: the block the bot lives on ("home") and its three chests.
// Seen from home: TOTEM chest on the LEFT, PVP on the RIGHT, GRIEF IN FRONT
// (kits.<name>.direction), each in a straight line within scanDistance blocks,
// at foot level or one block up or down. The fourth side has no container,
// so only one orientation fits: the bot works out which way it faces from the
// chests themselves. The result is saved and reused at the next login.

const { FACINGS } = require('./config');

const CONTAINER_RE = /(^|_)(chest|barrel|shulker_box)$/;

// Minecraft F3 yaw in degrees (0 = south, 90 = west) -> Mineflayer yaw (radians).
const f3ToYaw = (deg) => Math.PI - (deg * Math.PI) / 180;

// Unit step (x, z) for a direction relative to a cardinal facing.
function step(facing, direction) {
  const yaw = f3ToYaw(FACINGS[facing]);
  const fx = Math.round(-Math.sin(yaw));
  const fz = Math.round(-Math.cos(yaw));
  const v = { forward: [fx, fz], backward: [-fx, -fz], right: [-fz, fx], left: [fz, -fx] }[direction];
  return { x: v[0] + 0, z: v[1] + 0 }; // + 0 turns -0 into 0
}

function facingFromYaw(yaw) {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  if (Math.abs(fx) > Math.abs(fz)) return fx > 0 ? 'east' : 'west';
  return fz > 0 ? 'south' : 'north';
}

function scanFacing({ home, facing, blockAt, kits, scanDistance }) {
  const found = {};
  const missing = [];
  const used = new Set();
  for (const [name, kit] of Object.entries(kits)) {
    const d = step(facing, kit.direction);
    let hit = null;
    for (let dist = 1; dist <= scanDistance && !hit; dist++) {
      for (const dy of [0, 1, -1]) {
        const pos = { x: home.x + d.x * dist, y: home.y + dy, z: home.z + d.z * dist };
        const key = `${pos.x},${pos.y},${pos.z}`;
        const block = blockAt(pos);
        if (block && CONTAINER_RE.test(block.name) && !used.has(key)) {
          used.add(key);
          // Stand on the block just before the chest (home itself when adjacent).
          hit = { container: pos, block: block.name, distance: dist, standAt: { x: home.x + d.x * (dist - 1), y: home.y, z: home.z + d.z * (dist - 1) } };
          break;
        }
      }
    }
    if (hit) found[name] = hit;
    else missing.push(name);
  }
  return { ok: missing.length === 0, home: { ...home, facing }, kits: found, missing };
}

// position: the bot's position; yaw: its facing. blockAt({x,y,z}) -> { name } | null
// facing: a fixed facing (navigation.home.facing) or null to work it out.
function detectStation({ position, yaw, facing = null, blockAt, kits, scanDistance = 6 }) {
  const home = { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) };
  if (facing) return scanFacing({ home, facing, blockAt, kits, scanDistance });
  const own = facingFromYaw(yaw);
  const first = scanFacing({ home, facing: own, blockAt, kits, scanDistance });
  if (first.ok) return first;
  const others = Object.keys(FACINGS)
    .filter((f) => f !== own)
    .map((f) => scanFacing({ home, facing: f, blockAt, kits, scanDistance }))
    .filter((r) => r.ok);
  if (others.length === 1) return { ...others[0], turned: true };
  return { ...first, ambiguous: others.length > 1 };
}

const SIDE = { left: 'on the left', right: 'on the right', forward: 'in front', backward: 'behind' };

function describeStation(station, kits) {
  const parts = Object.entries(station.kits).map(([n, k]) => `${n}: ${k.block} ${k.distance} block(s) ${SIDE[kits[n]?.direction] || ''}`.trim());
  return `facing ${station.home.facing}; ${parts.join('; ')}`;
}

module.exports = { CONTAINER_RE, f3ToYaw, step, facingFromYaw, detectStation, describeStation };
