'use strict';

// One kit delivery:
//   1. walk to the kit's chest, open it like a player and take the kit;
//   2. teleport method: "/tpa <player>", wait until the player accepted and is
//      next to the bot; drop method: wait at the drop-off point;
//   3. throw the kit at the player and wait until the server reports that
//      THIS player picked up every stack (only then is it "delivered");
//   4. go back home (/kill to respawn at the base bed when too far to walk).
// Before the handoff, an undelivered kit goes back into its chest.

const { Vec3 } = require('vec3');
const { DeliveryError } = require('./queue');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Chest opening timings in ms (tests shorten them).
const OPEN_TIMINGS = { settleMs: 300, aimMs: 250, waitMs: 4000, betweenMs: 500, lastWaitMs: 10000 };

function itemMatches(item, spec) {
  if (!item) return false;
  return spec.name ? item.name === spec.name : new RegExp(spec.nameRegex).test(item.name);
}

const countMatching = (items, spec) => items.filter((it) => itemMatches(it, spec)).reduce((n, it) => n + it.count, 0);
const missingItems = (items, specs) => specs.map((spec) => ({ spec, missing: spec.count - countMatching(items, spec) })).filter((m) => m.missing > 0);

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
  if (signal?.aborted) throw new DeliveryError('the Minecraft connection was lost', { retryable: true });
}

async function waitFor(test, { timeoutMs, signal, message, everyMs = 250 }) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    checkAbort(signal);
    if (await test()) return;
    await sleep(everyMs);
  }
  throw new DeliveryError(message);
}

// Mineflayer sends every block click with sequence number 0; a real client
// counts up, and some anti-cheats drop repeated numbers.
function numberBlockInteractions(client) {
  const write = client.write.bind(client);
  let sequence = 0;
  client.write = (name, params) => {
    if ((name === 'block_place' || name === 'use_item') && params && 'sequence' in params) {
      sequence = sequence >= 2147483647 ? 1 : sequence + 1;
      params = { ...params, sequence };
    }
    return write(name, params);
  };
}

// The chest face pointing at the bot's eyes and the point to click on it.
function clickFace(bot, block) {
  const eye = bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0);
  const dx = eye.x - (block.position.x + 0.5);
  const dz = eye.z - (block.position.z + 0.5);
  if (Math.max(Math.abs(dx), Math.abs(dz)) >= 0.5) {
    if (Math.abs(dx) >= Math.abs(dz)) return { face: new Vec3(Math.sign(dx), 0, 0), cursor: new Vec3(dx > 0 ? 1 : 0, 0.5, 0.5) };
    return { face: new Vec3(0, 0, Math.sign(dz)), cursor: new Vec3(0.5, 0.5, dz > 0 ? 1 : 0) };
  }
  return { face: new Vec3(0, 1, 0), cursor: new Vec3(0.5, 0.875, 0.5) };
}

// A chest does not open with a full solid block on top of it.
function blockedChest(bot, block) {
  if (!/(^|_)chest$/.test(block.name) || block.name === 'ender_chest') return null;
  const above = bot.blockAt(block.position.offset(0, 1, 0));
  const solid = above && above.transparent === false && Array.isArray(above.shapes) && above.shapes.length === 1 && above.shapes[0].join(',') === '0,0,0,1,1,1';
  return solid ? `a ${above.name} block is on top of it` : null;
}

function createDelivery({ getBot, getSettings, getStation, logger, sendCommand, onChatLine, onStock = async () => {}, pathfinderLib = require('mineflayer-pathfinder') }) {
  const bot = () => getBot();
  let returning = false;

  async function goTo(pos, what, signal) {
    const b = bot();
    const nav = getSettings().navigation;
    checkAbort(signal);
    const moves = new pathfinderLib.Movements(b);
    moves.canDig = !!nav.allowDigging;
    moves.allow1by1towers = false;
    moves.scafoldingBlocks = [];
    moves.allowParkour = !!nav.allowParkour;
    moves.allowSprinting = !!nav.allowSprinting;
    b.pathfinder.setMovements(moves);
    try {
      await withTimeout(b.pathfinder.goto(new pathfinderLib.goals.GoalNear(pos.x, pos.y, pos.z, nav.arriveRadius)), nav.timeoutMs, `could not reach ${what} in ${Math.round(nav.timeoutMs / 1000)}s`, () =>
        b.pathfinder.stop()
      );
    } catch (e) {
      try {
        b.pathfinder.stop();
        b.clearControlStates();
      } catch {
        // disconnected
      }
      checkAbort(signal);
      throw e instanceof DeliveryError ? e : new DeliveryError(`could not walk to ${what}: ${e.message}`);
    }
    checkAbort(signal);
  }

  // Opens the container like a player, in this order:
  //   1. up to 5 clicks on the chest (the face turned towards the bot, then
  //      its top, alternately);
  //   2. twice: turn the camera away, click in the air, look back at the chest
  //      and click it again;
  //   3. wait 10 seconds, then click one last time.
  // Each click looks at the exact point it clicks and lets the server get that
  // rotation first (anti-cheats drop clicks that do not match the look). A
  // window that opens late, on a laggy server, is still used: earlier clicks
  // keep waiting for it, and a window is never closed between attempts.
  async function openContainer(pos, signal, what = 'the kit chest') {
    const b = bot();
    const block = b.blockAt(new Vec3(pos.x, pos.y, pos.z));
    if (!block) throw new DeliveryError(`${what} is not loaded`);
    if (!/chest|barrel|shulker_box/.test(block.name)) throw new DeliveryError(`there is no chest at the kit spot any more (found ${block.name})`);
    if (b.entity.position.distanceTo(block.position.offset(0.5, 0.5, 0.5)) > 4.5) throw new DeliveryError(`${what} is out of reach`);
    const blocked = blockedChest(b, block);
    if (blocked) throw new DeliveryError(`${what} cannot open: ${blocked}. Remove it`);

    const t = OPEN_TIMINGS;
    const top = { face: new Vec3(0, 1, 0), cursor: new Vec3(0.5, 0.875, 0.5) };
    const openings = []; // every click waits for the window; failures never settle
    const opened = () => Promise.race(openings);
    const errors = [];
    const said = [];
    const off = onChatLine((line) => said.push(line));
    let clicks = 0;

    async function click(aim) {
      checkAbort(signal);
      clicks++;
      try {
        await b.lookAt(block.position.offset(aim.cursor.x, aim.cursor.y, aim.cursor.z), true);
        await sleep(t.aimMs);
        // openContainer() would aim at the block centre again: keep our aim.
        const lookAt = b.lookAt;
        b.lookAt = async () => {};
        try {
          openings.push(b.openContainer(block, aim.face, aim.cursor).catch(() => new Promise(() => {})));
        } finally {
          b.lookAt = lookAt;
        }
        return await withTimeout(opened(), t.waitMs, 'no chest window opened');
      } catch (e) {
        if (e.retryable) throw e;
        errors.push(`click ${clicks}: ${e.message}`);
        return null;
      }
    }

    async function lookAwayAndClickAir() {
      checkAbort(signal);
      const { yaw, pitch } = b.entity;
      await b.look(yaw + Math.PI * (0.5 + Math.random() * 0.5) * (Math.random() < 0.5 ? -1 : 1), pitch, true).catch(() => {});
      await sleep(t.aimMs);
      b.swingArm(); // a click in the air
      await sleep(t.aimMs);
    }

    try {
      try {
        if (b.currentWindow) b.closeWindow(b.currentWindow);
      } catch {
        // already closed
      }
      b.clearControlStates();
      await sleep(t.settleMs); // stand still before clicking
      let win = null;
      for (let i = 0; i < 5 && !win; i++) {
        win = await click(i % 2 === 0 ? clickFace(b, block) : top);
        if (!win) await sleep(t.betweenMs);
      }
      for (let i = 0; i < 2 && !win; i++) {
        await lookAwayAndClickAir();
        win = await click(clickFace(b, block));
      }
      if (!win) {
        checkAbort(signal);
        win = await withTimeout(opened(), t.lastWaitMs, 'still no window').catch(() => null); // a late window counts
        if (!win) win = await click(clickFace(b, block));
      }
      if (win) {
        if (clicks > 1) await logger.info('chest.opened', `Opened ${what} after ${clicks} clicks.`);
        return win;
      }
    } finally {
      off();
    }
    const server = said.slice(-3).map((l) => `"${l.slice(0, 120)}"`).join(', ');
    throw new DeliveryError(`could not open ${what} after ${clicks} clicks (${errors.slice(-3).join('; ')})${server ? `; the server said: ${server}` : '; the server said nothing'}`);
  }

  async function takeKit(kitName, place, specs, signal) {
    const b = bot();
    if (!missingItems(b.inventory.items(), specs).length) return; // left over from an interrupted delivery
    if (b.inventory.emptySlotCount() < specs.length) throw new DeliveryError('the bot inventory is full; empty it');
    const chest = await openContainer(place.container, signal, `the ${kitName} chest`);
    try {
      for (const { spec, missing } of missingItems(b.inventory.items(), specs)) {
        const stacks = chest.containerItems().filter((it) => itemMatches(it, spec));
        const total = stacks.reduce((n, it) => n + it.count, 0);
        if (total < missing) {
          throw new DeliveryError(`the ${kitName} chest is empty`, { playerMessage: `Sorry, the ${kitName} kit is out of stock. Your order does not count.` });
        }
        let left = missing;
        for (const it of stacks) {
          if (left <= 0) break;
          const n = Math.min(left, it.count);
          checkAbort(signal);
          await withTimeout(chest.withdraw(it.type, null, n, it.nbt || null), 10000, 'taking the kit out of the chest timed out');
          left -= n;
        }
      }
    } finally {
      try {
        const items = chest.containerItems();
        await onStock(kitName, Math.min(...specs.map((spec) => Math.floor(countMatching(items, spec) / spec.count))));
      } catch {
        // stock count is informative only
      }
      chest.close();
    }
    if (missingItems(b.inventory.items(), specs).length) throw new DeliveryError('the kit did not arrive in the bot inventory');
  }

  async function putBack(kitName, place, specs, signal) {
    const b = bot();
    const held = b.inventory.items().filter((it) => specs.some((spec) => itemMatches(it, spec)));
    if (!held.length) return;
    await goTo(place.standAt, `the ${kitName} chest`, signal);
    const chest = await openContainer(place.container, signal, `the ${kitName} chest`);
    try {
      for (const it of held) await chest.deposit(it.type, null, it.count, it.nbt || null);
    } finally {
      chest.close();
    }
  }

  const playerEntity = (name) => bot().players[name]?.entity || null;
  const playerNear = (name, radius) => {
    const e = playerEntity(name);
    return !!e && e.position.distanceTo(bot().entity.position) <= radius;
  };

  // Throws the kit and waits until the target picked up every stack.
  async function handOver(req, specs, ctx) {
    const b = bot();
    const target = playerEntity(req.mc_username);
    if (!target) throw new DeliveryError('the player is not next to the bot');
    await b.lookAt(target.position.offset(0, target.height || 1.6, 0), true);
    const dropped = new Set();
    let picked = 0;
    let thrown = 0;
    let thief = null;
    const origin = b.entity.position.clone();
    const onSpawn = (e) => {
      if (e && e.name === 'item' && e.position.distanceTo(origin) < 4) dropped.add(e.id);
    };
    const onCollect = (collector, item) => {
      if (!item || !dropped.has(item.id)) return;
      dropped.delete(item.id);
      if (collector?.username === req.mc_username) picked++;
      else if (collector && collector.id !== b.entity.id) thief = collector.username || `entity ${collector.id}`;
    };
    b.on('entitySpawn', onSpawn);
    b.on('playerCollect', onCollect);
    try {
      await ctx.setStage('handoff'); // from now on the kit can leave the bot
      for (const spec of specs) {
        let left = spec.count;
        for (const it of b.inventory.items().filter((i) => itemMatches(i, spec))) {
          if (left <= 0) break;
          const n = Math.min(left, it.count);
          await withTimeout(b.toss(it.type, null, n), 10000, 'throwing the kit timed out');
          thrown++;
          left -= n;
        }
        if (left > 0) throw new DeliveryError('the kit disappeared from the bot inventory');
      }
      await waitFor(() => picked >= thrown || thief, { timeoutMs: getSettings().delivery.pickupTimeoutMs, message: 'the player did not pick up the kit in time' });
      if (thief) throw new DeliveryError(`the kit was picked up by ${thief} instead of ${req.mc_username}`);
    } finally {
      b.removeListener('entitySpawn', onSpawn);
      b.removeListener('playerCollect', onCollect);
    }
  }

  function distanceFromHome() {
    const home = getStation()?.home;
    return home ? bot().entity.position.distanceTo(new Vec3(home.x + 0.5, home.y, home.z + 0.5)) : 0;
  }
  const farFromHome = () => distanceFromHome() > getSettings().navigation.farFromHomeBlocks;

  async function goHome(signal) {
    const nav = getSettings().navigation;
    const home = getStation()?.home;
    if (!home) return;
    try {
      if (farFromHome() && nav.returnCommands.length) {
        returning = true;
        try {
          for (const cmd of nav.returnCommands) await sendCommand(cmd);
          await waitFor(() => !farFromHome() && bot().health > 0, {
            timeoutMs: nav.respawnWaitMs,
            signal,
            message: `still ${Math.round(distanceFromHome())} blocks from home after ${nav.returnCommands.join(', ')}`
          });
        } finally {
          returning = false;
        }
      }
      if (farFromHome()) {
        await logger.error('navigation.home', `The bot is ${Math.round(distanceFromHome())} blocks from home and cannot walk back. Sleep in a bed next to the base with the bot account, so ${nav.returnCommands.join(', ') || '/kill'} brings it back.`);
        return;
      }
      await goTo(home, 'home', signal);
    } catch (e) {
      await logger.warn('navigation.home', `Could not get back home: ${e.message}`);
    }
  }

  // Resolves when delivered; throws a DeliveryError otherwise.
  async function deliver(req, ctx, signal) {
    const s = getSettings();
    const d = s.delivery;
    const kit = s.kits[req.kit];
    const place = getStation()?.kits[req.kit];
    if (!kit || !place) throw new DeliveryError(`the ${req.kit} chest is not known`);
    const teleport = d.method === 'teleport';
    let handedOff = false;
    const tracked = { setStage: async (st) => ((handedOff = handedOff || st === 'handoff'), ctx.setStage(st)) };
    try {
      await ctx.setStage('walking');
      if (farFromHome()) await goHome(signal);
      if (farFromHome()) throw new DeliveryError('the bot is away from its base and cannot get back');
      await goTo(place.standAt, `the ${req.kit} chest`, signal);

      await ctx.setStage('taking');
      await takeKit(req.kit, place, kit.items, signal);

      await ctx.setStage('meeting');
      if (!bot().players[req.mc_username]) throw new DeliveryError('the player went offline', { playerMessage: null });
      if (d.instructions) await ctx.notify(d.instructions.replace(/\{kit\}/g, req.kit).replace(/\{player\}/g, req.mc_username));
      if (teleport) for (const cmd of d.commands) await sendCommand(cmd.replace(/\{player\}/g, req.mc_username));
      else await goTo(d.dropoff || getStation().home, 'the drop-off point', signal);
      await waitFor(() => playerNear(req.mc_username, d.playerRadius), {
        timeoutMs: d.waitForPlayerMs,
        signal,
        message: teleport ? 'the player did not accept the teleport request in time' : 'the player did not come to the bot in time'
      }).catch((e) => {
        if (e.retryable) throw e;
        throw new DeliveryError(e.message, {
          playerMessage: teleport ? 'You did not accept my teleport request in time, so the order was cancelled. It does not count.' : 'You did not come to the bot in time, so the order was cancelled. It does not count.'
        });
      });

      const pos = bot().entity.position;
      const others = Object.values(bot().players)
        .filter((p) => p.entity && p.username !== req.mc_username && p.username !== bot().username && p.entity.position.distanceTo(pos) < 16)
        .map((p) => p.username);
      const report = [`📍 ${Math.floor(pos.x)} ${Math.floor(pos.y)} ${Math.floor(pos.z)}`, `👥 Other players nearby: ${others.join(', ') || 'none'}`].join('\n');
      try {
        await handOver(req, kit.items, tracked);
        await logger.info('delivery.report', `✅ ${req.kit} kit delivered to ${req.mc_username} (request #${req.id})`, report);
      } catch (e) {
        if (handedOff) await logger.warn('delivery.report', `⚠️ ${req.kit} kit for ${req.mc_username} not confirmed (request #${req.id}): ${e.message}`, report);
        throw e;
      }
    } catch (e) {
      // Not handed over: put the kit back if the chest is within walking distance.
      if (!handedOff && !signal?.aborted) {
        if (farFromHome()) {
          if (bot().inventory.items().some((it) => kit.items.some((spec) => itemMatches(it, spec)))) {
            await logger.warn('kit.return', `The bot is away from base holding the ${req.kit} kit; it may be lost when it respawns.`);
          }
        } else {
          await putBack(req.kit, place, kit.items, signal).catch((err) => logger.warn('kit.return', `Could not put the ${req.kit} kit back: ${err.message}`));
        }
      }
      throw e;
    } finally {
      if (!signal?.aborted && s.navigation.returnHomeAfterDelivery) await goHome(signal);
    }
  }

  return { deliver, goHome, isReturning: () => returning };
}

module.exports = { OPEN_TIMINGS, itemMatches, countMatching, missingItems, clickFace, numberBlockInteractions, createDelivery };
