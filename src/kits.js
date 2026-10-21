'use strict';

// Kit locations, retrieval and delivery.
//
// Directions: the bot's base pose is navigation.home (x, y, z + facing). Kits
// are placed relative to that pose: TOTEM to the LEFT, PVP to the RIGHT and
// GRIEF IN FRONT (configurable per kit: left, right, forward or backward). A kit either gives explicit "standAt"
// coordinates or a "distance" in blocks from home along its direction.
//
// Retrieval methods:
//   chest   - open a container at retrieval.container and withdraw the items.
//   command - run server commands (only if your server really has them) and
//             wait for the items to appear in the inventory.
// Delivery methods:
//   drop     - walk to delivery.dropoff, wait for the player, toss the items.
//   teleport - run commands such as "/tpa {player}" (or accept the player's
//              teleport request), wait until the player is nearby, toss.
// A delivery is "delivered" only after the server reports that the target
// player picked up every tossed item stack.

const { Vec3 } = require('vec3');
const { FACINGS, resolveDelivery } = require('./config');
const { DeliveryError } = require('./queue');

// ---- geometry -------------------------------------------------------------

// Mineflayer yaw (radians): 0 faces north (-Z), PI/2 faces west (-X).
// Minecraft F3 yaw (degrees): 0 = south, 90 = west, 180 = north, -90 = east.
function f3DegreesToYaw(deg) {
  return Math.PI - (deg * Math.PI) / 180;
}

function homeYaw(home) {
  if (!home) return null;
  if (typeof home.yawDegrees === 'number') return f3DegreesToYaw(home.yawDegrees);
  if (home.facing) return f3DegreesToYaw(FACINGS[home.facing]);
  return f3DegreesToYaw(FACINGS.north);
}

// Horizontal unit vector for a direction relative to `yaw`.
function directionVector(yaw, direction) {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const round = (v) => (Math.abs(v) < 1e-9 ? 0 : v);
  switch (direction) {
    case 'forward':
      return { x: round(fx), z: round(fz) };
    case 'backward':
      return { x: round(-fx), z: round(-fz) };
    case 'right':
      return { x: round(-fz), z: round(fx) };
    case 'left':
      return { x: round(fz), z: round(-fx) };
    default:
      throw new Error(`unknown direction ${direction}`);
  }
}

function resolveStandAt(settings, kitName) {
  const kit = settings.kits[kitName];
  if (kit.standAt) return { ...kit.standAt };
  const home = settings.navigation.home;
  const v = directionVector(homeYaw(home), kit.direction);
  return { x: home.x + Math.round(v.x * kit.distance), y: home.y, z: home.z + Math.round(v.z * kit.distance) };
}

// ---- items ----------------------------------------------------------------

function itemMatches(item, spec) {
  if (!item) return false;
  if (spec.name) return item.name === spec.name;
  return new RegExp(spec.nameRegex).test(item.name);
}

function countMatching(items, spec) {
  return items.filter((it) => itemMatches(it, spec)).reduce((n, it) => n + it.count, 0);
}

function missingItems(inventoryItems, specs) {
  return specs.map((spec) => ({ spec, missing: Math.max(0, spec.count - countMatching(inventoryItems, spec)) })).filter((m) => m.missing > 0);
}

// ---- mineflayer helpers ---------------------------------------------------

// The face of `block` that points towards the bot's eyes, and the click
// position on it (0..1 within the block). Side faces are preferred when the
// bot is beside the block.
function clickFace(bot, block) {
  const eye = bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0);
  const d = { x: eye.x - (block.position.x + 0.5), y: eye.y - (block.position.y + 0.5), z: eye.z - (block.position.z + 0.5) };
  const top = 0.875; // chests are 14/16 of a block high
  if (Math.max(Math.abs(d.x), Math.abs(d.z)) >= 0.5) {
    if (Math.abs(d.x) >= Math.abs(d.z)) {
      const s = Math.sign(d.x);
      return { direction: new Vec3(s, 0, 0), cursor: new Vec3(s > 0 ? 1 : 0, 0.5, 0.5) };
    }
    const s = Math.sign(d.z);
    return { direction: new Vec3(0, 0, s), cursor: new Vec3(0.5, 0.5, s > 0 ? 1 : 0) };
  }
  return d.y >= 0 ? { direction: new Vec3(0, 1, 0), cursor: new Vec3(0.5, top, 0.5) } : { direction: new Vec3(0, -1, 0), cursor: new Vec3(0.5, 0, 0.5) };
}

function withTimeout(promise, ms, message, onTimeout) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (onTimeout) onTimeout();
        reject(new DeliveryError(message));
      }, ms);
    })
  ]).finally(() => clearTimeout(timer));
}

function checkAbort(signal) {
  if (signal && signal.aborted) throw new DeliveryError('Minecraft connection lost', { retryable: true });
}

async function waitFor(predicate, { timeoutMs, intervalMs = 250, signal, message }) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    checkAbort(signal);
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new DeliveryError(message);
}

function createKitService({ getBot, getSettings, logger, sendCommand, onChatLine, pathfinderLib = require('mineflayer-pathfinder') }) {
  function configureMovements(bot) {
    const nav = getSettings().navigation;
    const moves = new pathfinderLib.Movements(bot);
    moves.canDig = !!nav.allowDigging;
    moves.allow1by1towers = !!nav.allowPlacing;
    if (!nav.allowPlacing) moves.scafoldingBlocks = [];
    moves.allowParkour = !!nav.allowParkour;
    moves.allowSprinting = !!nav.allowSprinting;
    bot.pathfinder.setMovements(moves);
  }

  async function goTo(pos, radius, timeoutMs, signal, what) {
    const bot = getBot();
    checkAbort(signal);
    configureMovements(bot);
    const goal = new pathfinderLib.goals.GoalNear(pos.x, pos.y, pos.z, radius);
    try {
      await withTimeout(bot.pathfinder.goto(goal), timeoutMs, `could not reach ${what} within ${Math.round(timeoutMs / 1000)}s`, () => bot.pathfinder.stop());
    } catch (e) {
      checkAbort(signal);
      if (e instanceof DeliveryError) throw e;
      throw new DeliveryError(`navigation to ${what} failed: ${e.message}`);
    }
    checkAbort(signal);
  }

  function inventoryItems() {
    return getBot().inventory.items();
  }

  async function openContainerAt(pos, signal) {
    const bot = getBot();
    const block = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
    if (!block) throw new DeliveryError('kit container is not loaded');
    if (!/chest|barrel|shulker_box/.test(block.name)) throw new DeliveryError(`no container at the kit location (found ${block.name})`);
    const dist = bot.entity.position.distanceTo(block.position.offset(0.5, 0.5, 0.5));
    if (dist > 4.5) throw new DeliveryError('kit container is out of reach');
    // Click the face of the container that points at the bot, with the click
    // position on that face, like a player would. Mineflayer's default (top
    // face, centre of the block) can be ignored by anti-cheat plugins. If no
    // window opens, retry, once on the top face as a fallback.
    const attempts = [clickFace(bot, block), { direction: new Vec3(0, 1, 0), cursor: new Vec3(0.5, 0.875, 0.5) }, clickFace(bot, block)];
    const errors = [];
    for (const { direction, cursor } of attempts) {
      checkAbort(signal);
      if (bot.currentWindow) {
        try {
          bot.closeWindow(bot.currentWindow);
        } catch {
          // already closed
        }
      }
      try {
        return await withTimeout(bot.openContainer(block, direction, cursor), 5000, 'no chest window opened');
      } catch (e) {
        errors.push(e.message);
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    throw new DeliveryError(`could not open the kit container at ${block.name} (${errors.join('; ')})`);
  }

  async function retrieveFromChest(kitName, kit, signal) {
    const specs = kit.retrieval.items;
    let missing = missingItems(inventoryItems(), specs);
    if (!missing.length) return; // left over from an interrupted delivery
    const bot = getBot();
    const stackSize = (spec) => (spec.name && bot.registry.itemsByName[spec.name]?.stackSize) || 1;
    const stacksNeeded = missing.reduce((n, m) => n + Math.ceil(m.missing / stackSize(m.spec)), 0);
    if (bot.inventory.emptySlotCount() < Math.min(stacksNeeded, 36)) throw new DeliveryError('bot inventory does not have enough free space');

    const container = await openContainerAt(kit.retrieval.container, signal);
    try {
      for (const { spec, missing: need } of missing) {
        const available = container.containerItems().filter((it) => itemMatches(it, spec));
        const total = available.reduce((n, it) => n + it.count, 0);
        if (total < need) {
          throw new DeliveryError(`kit "${kitName}" is out of stock (${spec.name || spec.nameRegex}: ${total}/${need})`, {
            playerMessage: `Sorry, the ${kitName} kit is out of stock right now. It did not count against your limits.`
          });
        }
        let remaining = need;
        for (const it of available) {
          if (remaining <= 0) break;
          const take = Math.min(remaining, it.count);
          checkAbort(signal);
          await withTimeout(container.withdraw(it.type, null, take, it.nbt || null), 10000, 'timed out withdrawing items');
          remaining -= take;
        }
      }
    } finally {
      try {
        container.close();
      } catch {
        // window already closed
      }
    }
    missing = missingItems(inventoryItems(), specs);
    if (missing.length) throw new DeliveryError('kit items did not arrive in the bot inventory');
  }

  async function retrieveByCommand(kitName, kit, request, signal) {
    for (const cmd of kit.retrieval.commands) await sendCommand(cmd.replace(/\{player\}/g, request.mc_username).replace(/\{kit\}/g, kitName));
    await waitFor(() => missingItems(inventoryItems(), kit.retrieval.items).length === 0, {
      timeoutMs: kit.retrieval.timeoutMs || 15000,
      signal,
      message: 'kit items did not arrive after running the retrieval command'
    });
  }

  function playerEntity(name) {
    const p = getBot().players[name];
    return p && p.entity ? p.entity : null;
  }

  function playerNear(name, radius) {
    const e = playerEntity(name);
    return !!e && e.position.distanceTo(getBot().entity.position) <= radius;
  }

  // Tosses exactly the kit items and waits for the target to pick all of them up.
  async function tossAndConfirm(request, specs, delivery, ctx) {
    const bot = getBot();
    const target = request.mc_username;
    const entity = playerEntity(target);
    if (!entity) throw new DeliveryError('player is not nearby');
    await bot.lookAt(entity.position.offset(0, entity.height || 1.62, 0), true);

    const dropped = new Set();
    let collectedByTarget = 0;
    let stolenBy = null;
    let tosses = 0;
    const origin = bot.entity.position.clone();
    const onSpawn = (e) => {
      if ((e.name === 'item' || e.type === 'object' || e.name === 'item_stack') && e.position.distanceTo(origin) < 4) dropped.add(e.id);
    };
    const onCollect = (collector, collected) => {
      if (!collected || !dropped.has(collected.id)) return;
      dropped.delete(collected.id);
      if (collector && collector.username === target) collectedByTarget++;
      else if (collector && collector.id !== bot.entity.id) stolenBy = collector.username || `entity ${collector.id}`;
    };
    bot.on('entitySpawn', onSpawn);
    bot.on('itemDrop', onSpawn);
    bot.on('playerCollect', onCollect);
    try {
      // From here on the kit may leave the bot: persist the stage first.
      await ctx.setStage('handoff');
      for (const spec of specs) {
        let remaining = spec.count;
        for (const it of bot.inventory.items().filter((i) => itemMatches(i, spec))) {
          if (remaining <= 0) break;
          const n = Math.min(remaining, it.count);
          await withTimeout(bot.toss(it.type, null, n), 10000, 'timed out tossing the kit');
          tosses++;
          remaining -= n;
        }
        if (remaining > 0) throw new DeliveryError('kit items disappeared from the inventory before tossing');
      }
      await waitFor(() => collectedByTarget >= tosses || stolenBy !== null, {
        timeoutMs: delivery.pickupTimeoutMs,
        signal: null,
        message: 'player did not pick up the kit in time'
      });
      if (stolenBy) throw new DeliveryError(`kit was picked up by ${stolenBy} instead of ${target}`);
    } finally {
      bot.removeListener('entitySpawn', onSpawn);
      bot.removeListener('itemDrop', onSpawn);
      bot.removeListener('playerCollect', onCollect);
    }
  }

  async function waitForTeleportRequest(request, delivery, signal) {
    const re = new RegExp(delivery.acceptRequest.pattern, 'i');
    let matched = false;
    const off = onChatLine((line) => {
      const m = re.exec(line);
      if (m && m.groups && m.groups.username && m.groups.username.toLowerCase() === request.mc_username.toLowerCase()) matched = true;
    });
    try {
      await waitFor(() => matched, { timeoutMs: delivery.waitForPlayerMs, signal, message: 'player did not send a teleport request in time' });
    } finally {
      off();
    }
    await sendCommand(delivery.acceptRequest.command.replace(/\{player\}/g, request.mc_username));
  }

  async function returnItems(kitName, kit, signal) {
    if (kit.retrieval.method !== 'chest') return;
    const leftovers = inventoryItems().filter((it) => kit.retrieval.items.some((spec) => itemMatches(it, spec)));
    if (!leftovers.length) return;
    await goTo(resolveStandAt(getSettings(), kitName), getSettings().navigation.arriveRadius, kit.timeoutMs || getSettings().navigation.defaultTimeoutMs, signal, 'kit container');
    const container = await openContainerAt(kit.retrieval.container, signal);
    try {
      for (const it of leftovers) await container.deposit(it.type, null, it.count, it.nbt || null);
    } finally {
      try {
        container.close();
      } catch {
        // already closed
      }
    }
  }

  // What is around the bot right after it teleported to a player. Sent to the
  // Discord log channel only (coordinates never go to the console).
  function surroundings(radius = 16) {
    const bot = getBot();
    const pos = bot.entity.position;
    const blocks = { chest: 0, trapped_chest: 0, barrel: 0, shulker_box: 0, ender_chest: 0 };
    if (typeof bot.findBlocks === 'function' && bot.registry && bot.registry.blocksArray) {
      const ids = bot.registry.blocksArray.filter((b) => /^(chest|trapped_chest|barrel|ender_chest)$|shulker_box$/.test(b.name)).map((b) => b.id);
      for (const p of bot.findBlocks({ matching: ids, maxDistance: radius, count: 5000 })) {
        const block = bot.blockAt(p);
        if (!block) continue;
        const key = /shulker_box$/.test(block.name) ? 'shulker_box' : block.name;
        if (key in blocks) blocks[key]++;
      }
    }
    let droppedShulkers = 0;
    const players = [];
    for (const e of Object.values(bot.entities || {})) {
      if (!e || e === bot.entity || !e.position || e.position.distanceTo(pos) > radius) continue;
      if (e.type === 'player' && e.username) players.push(e.username);
      else if (e.name === 'item' && typeof e.getDroppedItem === 'function') {
        const item = e.getDroppedItem();
        if (item && /shulker_box$/.test(item.name)) droppedShulkers += item.count;
      }
    }
    const dim = bot.game && bot.game.dimension ? String(bot.game.dimension).replace(/^minecraft:/, '') : 'unknown';
    return { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), dimension: dim, blocks, droppedShulkers, players };
  }

  // Snapshot of where the kit is handed over, taken just before tossing.
  function locationReport(request) {
    try {
      const r = surroundings();
      const others = r.players.filter((p) => p !== request.mc_username && p !== getBot().username);
      return [
        `🕒 <t:${Math.floor(Date.now() / 1000)}:F>`,
        `📦 Kit: **${request.kit}** for **${request.mc_username}** (request #${request.id})`,
        `📍 **${r.x} ${r.y} ${r.z}** (${r.dimension})`,
        `🗄️ Within 16 blocks: ${r.blocks.chest} chest(s), ${r.blocks.trapped_chest} trapped chest(s), ${r.blocks.barrel} barrel(s), ${r.blocks.shulker_box} shulker box(es) placed, ${r.blocks.ender_chest} ender chest(s)`,
        `🟪 Shulker boxes on the ground: ${r.droppedShulkers}`,
        `👥 Other players nearby: ${others.length ? others.join(', ') : 'none'}`
      ].join('\n');
    } catch (e) {
      logger.debug('delivery.report', `Could not build the location report: ${e.message}`);
      return null;
    }
  }

  // One message per handed-over kit in the private "delivered-kits" channel
  // (event type "delivery.report"); the details never reach the console.
  async function postDeliveryReport(request, details, delivered, reason) {
    if (!details) return;
    const title = delivered ? `✅ ${request.kit} kit delivered to ${request.mc_username}` : `⚠️ ${request.kit} kit not confirmed for ${request.mc_username}`;
    const status = delivered ? '✔️ Picked up by the player' : `❔ Pickup not confirmed: ${reason}`;
    await logger.info('delivery.report', title, undefined, `${details}\n${status}`);
  }

  function distanceFromHome() {
    const home = getSettings().navigation.home;
    if (!home) return 0;
    return getBot().entity.position.distanceTo(new Vec3(home.x + 0.5, home.y, home.z + 0.5));
  }

  const isFarFromHome = () => distanceFromHome() > getSettings().navigation.farFromHomeBlocks;
  let returning = false;

  // Gets back to base. When the bot is too far to walk (e.g. after teleporting
  // to a player), it runs navigation.returnCommands (default "/kill": respawn
  // at the bed next to the base), then walks the last blocks to home.
  async function goHome(signal) {
    const nav = getSettings().navigation;
    if (!nav.home || !nav.returnHomeAfterDelivery) return;
    try {
      if (isFarFromHome() && nav.returnCommands.length) {
        returning = true;
        try {
          for (const cmd of nav.returnCommands) await sendCommand(cmd);
          await waitFor(() => !isFarFromHome() && getBot().health > 0, {
            timeoutMs: nav.respawnWaitMs,
            signal,
            message: `still ${Math.round(distanceFromHome())} blocks from home after ${nav.returnCommands.join(', ')}`
          });
        } finally {
          returning = false;
        }
      }
      if (isFarFromHome()) {
        await logger.error('navigation.home', `The bot is ${Math.round(distanceFromHome())} blocks from home and cannot walk back. Check that its bed is next to the base and that ${nav.returnCommands.join(', ') || 'a return command'} works on this server.`);
        return;
      }
      await goTo(nav.home, nav.arriveRadius, nav.defaultTimeoutMs, signal, 'home');
    } catch (e) {
      await logger.warn('navigation.home', `Could not return home: ${e.message}`);
    }
  }

  // Runs one complete delivery. Resolves { outcome: 'delivered' } only after a
  // confirmed pickup; throws DeliveryError otherwise.
  async function deliver(request, ctx, signal) {
    const s = getSettings();
    const kitName = request.kit;
    const kit = s.kits[kitName];
    if (!kit) throw new DeliveryError(`kit "${kitName}" is not configured`);
    const delivery = resolveDelivery(s, kitName);
    const timeoutMs = kit.timeoutMs || s.navigation.defaultTimeoutMs;
    let report = null;
    let handedOff = false;
    const trackedCtx = {
      ...ctx,
      setStage: async (st) => {
        if (st === 'handoff') handedOff = true;
        await ctx.setStage(st);
      }
    };

    try {
      await ctx.setStage('navigating');
      if (isFarFromHome()) {
        await goHome(signal);
        if (isFarFromHome()) throw new DeliveryError('the bot is away from its base and could not get back');
      }
      await goTo(resolveStandAt(s, kitName), s.navigation.arriveRadius, timeoutMs, signal, `the ${kitName} kit (${kit.direction})`);
      if (kit.lookYawDegrees !== undefined) await getBot().look(f3DegreesToYaw(kit.lookYawDegrees), 0, true);

      await ctx.setStage('retrieving');
      if (kit.retrieval.method === 'chest') await retrieveFromChest(kitName, kit, signal);
      else await retrieveByCommand(kitName, kit, request, signal);

      await ctx.setStage('delivering');
      if (!getBot().players[request.mc_username]) throw new DeliveryError('player went offline', { playerMessage: null });
      const instructions = delivery.instructions.replace(/\{kit\}/g, kitName).replace(/\{player\}/g, request.mc_username);
      if (instructions) await ctx.notify(instructions);

      if (delivery.method === 'drop') {
        await goTo(delivery.dropoff, s.navigation.arriveRadius, timeoutMs, signal, 'the drop-off point');
      } else if (delivery.acceptRequest) {
        await waitForTeleportRequest(request, delivery, signal);
      } else {
        for (const cmd of delivery.commands) await sendCommand(cmd.replace(/\{player\}/g, request.mc_username));
      }
      const teleport = delivery.method === 'teleport';
      try {
        await waitFor(() => playerNear(request.mc_username, delivery.playerRadius), {
          timeoutMs: delivery.waitForPlayerMs,
          signal,
          message: teleport ? 'player did not accept the teleport request in time' : 'player did not come close enough to receive the kit'
        });
      } catch (e) {
        if (!(e instanceof DeliveryError) || e.retryable) throw e;
        throw new DeliveryError(e.message, {
          playerMessage: teleport
            ? 'You did not accept my teleport request in time, so your order was cancelled. It did not count against your limits.'
            : 'You did not come to the bot in time, so your order was cancelled. It did not count against your limits.'
        });
      }

      if (teleport) await logger.info('delivery.teleported', `Teleported to ${request.mc_username} for a ${request.kit} kit.`);
      report = locationReport(request);
      await tossAndConfirm(request, kit.retrieval.items, delivery, trackedCtx);
      await postDeliveryReport(request, report, true);
      return { outcome: 'delivered' };
    } catch (e) {
      // The kit was thrown (report taken just before) but the pickup was not confirmed.
      if (report && handedOff) await postDeliveryReport(request, report, false, e.message);
      // Put untouched kit items back so stock is not lost (only before handoff,
      // and only when the chest is within walking distance).
      if (isFarFromHome()) {
        const held = inventoryItems().filter((it) => kit.retrieval.items.some((spec) => itemMatches(it, spec)));
        if (held.length) await logger.warn('kit.return', `The bot is away from base holding ${held.length} ${kitName} kit stack(s); they may be lost when it returns.`);
      } else if (delivery.returnUndelivered && !(signal && signal.aborted)) {
        try {
          await returnItems(kitName, kit, signal);
        } catch (err) {
          await logger.warn('kit.return', `Could not return ${kitName} kit items to the container: ${err.message}`);
        }
      }
      throw e;
    } finally {
      if (delivery.afterCommands.length && !(signal && signal.aborted)) {
        for (const cmd of delivery.afterCommands) await sendCommand(cmd.replace(/\{player\}/g, request.mc_username)).catch(() => {});
      }
      if (!(signal && signal.aborted)) await goHome(signal);
    }
  }

  return { deliver, goHome, isReturning: () => returning };
}

module.exports = {
  clickFace,
  f3DegreesToYaw,
  homeYaw,
  directionVector,
  resolveStandAt,
  itemMatches,
  countMatching,
  missingItems,
  createKitService
};
