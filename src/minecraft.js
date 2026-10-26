'use strict';

// The Minecraft side: connects, logs in (/reg or /log), reads the chat for
// commands, finds the kit station and runs the delivery queue.

const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const { getSetting, setSetting, setStatus } = require('./db');
const { loadSettings } = require('./config');
const chat = require('./chat');
const { createCommandHandler } = require('./commands');
const { createQueue, recoverInterrupted } = require('./queue');
const { createDelivery, numberBlockInteractions } = require('./delivery');
const { detectStation, describeStation } = require('./station');
const linking = require('./linking');
const { recordStock } = require('./stock');

const MAX_CHAT = 256;
const fill = (template, values) => String(template).replace(/\{(\w+)\}/g, (m, k) => (k in values ? values[k] : m));
const clean = (text, max = MAX_CHAT) =>
  String(text)
    .replace(/[\u0000-\u001f\u007f§]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, Math.min(max, MAX_CHAT));

function createMinecraftBot({ config, db, logger, checkMembership }) {
  const { secrets } = config;
  let settings = config.settings;
  const getSettings = () => settings;
  const runtime = { connected: false, ready: false, stationReady: false, paused: false, maintenance: false };
  let bot = null;
  let station = null;
  let stopping = false;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let abort = null;
  const timers = [];
  const lineListeners = new Set();
  let compiled = compile(settings);
  let lastChatAt = Date.now();
  let silenceWarned = false;
  let lastUnreadableAt = 0;
  let lastStationTry = 0;
  let lastStationError = null;
  let lastRecalibrate = null;
  let lastReload = null;

  function compile(s) {
    return { ignore: s.chat.ignorePattern ? new RegExp(s.chat.ignorePattern, 'i') : null, patterns: s.chat.patterns.map((p) => new RegExp(p, 'i')) };
  }

  // ---- outgoing chat, one message every chat.minDelayMs ----------------------
  const outbox = [];
  let pumping = false;
  function send(text) {
    return new Promise((resolve, reject) => {
      outbox.push({ text, resolve, reject });
      pump();
    });
  }
  async function pump() {
    if (pumping) return;
    pumping = true;
    while (outbox.length) {
      const item = outbox.shift();
      if (!bot || !runtime.connected) {
        item.reject(new Error('not connected'));
        continue;
      }
      try {
        bot.chat(item.text);
        item.resolve();
      } catch (e) {
        item.reject(e);
      }
      await new Promise((r) => setTimeout(r, settings.chat.minDelayMs));
    }
    pumping = false;
  }
  const sendCommand = (cmd) => send(clean(cmd));
  async function reply(name, message) {
    if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) return;
    await send(fill(settings.chat.replyCommand, { player: name, message: clean(message, settings.chat.maxLength) })).catch(() => {});
  }

  // ---- players -------------------------------------------------------------
  // bot.players exists only once Mineflayer has loaded its plugins.
  const onlineNames = () => (bot?.players ? Object.keys(bot.players) : []);
  function onlinePlayer(name) {
    if (!bot || !name) return null;
    const exact = chat.onlineName(name, onlineNames());
    const p = exact && bot.players[exact];
    return p ? { username: p.username, uuid: p.uuid || null } : null;
  }

  // ---- delivery --------------------------------------------------------------
  const delivery = createDelivery({
    getBot: () => bot,
    getSettings,
    getStation: () => station,
    logger,
    sendCommand,
    onChatLine: (fn) => (lineListeners.add(fn), () => lineListeners.delete(fn)),
    onStock: (kit, left) => recordStock(db, logger, { kit, left, lowThreshold: settings.stock.lowThreshold })
  });

  const queue = createQueue({
    db,
    getSettings,
    logger,
    canRun: () => runtime.ready && runtime.stationReady && !runtime.paused && !runtime.maintenance && !stopping,
    async verify(req) {
      const link = await linking.activeLinkByUsername(db, req.mc_username);
      if (!link || link.discord_id !== req.discord_id) return { ok: false, reason: 'the account link is no longer active' };
      const m = await checkMembership(req.discord_id);
      if (m.status === 'unavailable') return { ok: false, retryLater: true };
      if (m.status !== 'member') return { ok: false, reason: `Discord check failed (${m.status})`, playerMessage: 'Your order was cancelled: you are no longer verified in our Discord server.' };
      if (!onlinePlayer(req.mc_username)) return { ok: false, reason: 'the player is offline' };
      return { ok: true };
    },
    async deliver(req, ctx) {
      await delivery.deliver(req, { ...ctx, notify: (msg) => reply(req.mc_username, msg) }, abort?.signal);
      if (settings.chat.deliveryAnnouncement) await send(clean(fill(settings.chat.deliveryAnnouncement, { player: req.mc_username, kit: req.kit }))).catch(() => {});
    },
    notify: (req, msg) => (onlinePlayer(req.mc_username) ? reply(req.mc_username, msg) : Promise.resolve())
  });

  const handleCommand = createCommandHandler({ db, getSettings, getRuntime: () => runtime, logger, checkMembership, reply, onQueued: () => queue.poke() });

  // ---- chat intake -------------------------------------------------------------
  function onChat({ username, message }, where) {
    if (!username || username.toLowerCase() === (bot?.username || '').toLowerCase()) return;
    const player = onlinePlayer(username);
    if (!player && settings.chat.requireOnlinePlayer) return;
    handleCommand(player ? player.username : username, message, player || { username, uuid: null }).catch((e) =>
      logger.error('chat.error', `Error handling "${message.slice(0, 40)}" from ${username} (${where}): ${e.message}`)
    );
  }

  function onLine(line, where) {
    lastChatAt = Date.now();
    logger.debug('chat.line', `[${where}] ${line}`);
    for (const fn of [...lineListeners]) {
      try {
        fn(line);
      } catch {
        // a listener must not break chat handling
      }
    }
  }

  function unreadable(line, where) {
    if (!chat.mentionsCommand(line, settings.chat) || Date.now() - lastUnreadableAt < 30000) return;
    lastUnreadableAt = Date.now();
    logger.warn('chat.unreadable', `A chat line mentions a command, but its sender is not a player in the tab list (${where}): "${chat.cleanText(line).slice(0, 200)}"`);
  }

  // Reads the raw chat packets (see src/chat.js).
  function attachChat(b) {
    let ChatMessage = null;
    const text = (json) => {
      if (!ChatMessage && b.registry) {
        try {
          ChatMessage = require('prismarine-chat')(b.registry);
        } catch {
          ChatMessage = null;
        }
      }
      return chat.componentText(json, ChatMessage);
    };
    const playersByUuid = () => Object.fromEntries(Object.values(b.players || {}).map((p) => [p.uuid, p.username]));

    b._client.on('playerChat', (data) => {
      try {
        const senderName = text(data.senderName);
        if (data.plainMessage !== undefined) {
          onLine(`${senderName}: ${data.plainMessage}`, 'player chat');
          const parsed = chat.parsePlayerChat({ senderUuid: data.sender, plainMessage: data.plainMessage, senderName }, { playersByUuid: playersByUuid(), online: onlineNames() });
          if (parsed) onChat(parsed, 'player chat');
          else unreadable(data.plainMessage, 'player chat');
        } else {
          const message = text(data.formattedMessage);
          onLine(`${senderName}: ${message}`, 'profileless chat');
          const parsed = chat.parseProfilelessChat({ senderName, message }, { online: onlineNames() });
          if (parsed) onChat(parsed, 'profileless chat');
          else unreadable(message, 'profileless chat');
        }
      } catch (e) {
        logger.warn('chat.error', `Could not read a player chat message: ${e.message}`);
      }
    });

    b._client.on('systemChat', (data) => {
      if (data.positionId === 2) return; // action bar
      try {
        const line = text(data.formattedMessage);
        onLine(line, 'system');
        if (!runtime.connected || compiled.ignore?.test(chat.cleanText(line))) return; // e.g. relayed from Discord
        const parsed = chat.parseSystemLine(line, { online: onlineNames(), botName: b.username, ...compiled });
        if (parsed) onChat(parsed, 'system chat');
        else unreadable(line, 'system');
      } catch (e) {
        logger.warn('chat.error', `Could not read a system message: ${e.message}`);
      }
    });
  }

  // ---- login (AuthMe) -------------------------------------------------------------
  function waitForLine(patterns, timeoutMs) {
    const res = patterns.map((p) => new RegExp(p, 'i'));
    return new Promise((resolve) => {
      const done = (value) => {
        clearTimeout(timer);
        lineListeners.delete(listener);
        resolve(value);
      };
      const listener = (line) => {
        const index = res.findIndex((re) => re.test(line));
        if (index >= 0) done({ index, line });
      };
      const timer = setTimeout(() => done(null), timeoutMs);
      lineListeners.add(listener);
    });
  }

  async function login() {
    const a = settings.auth;
    if (!a.enabled) return;
    if (!secrets.minecraft.password) throw new Error('MINECRAFT_PASSWORD is not set');
    const key = `minecraft.registered.${secrets.minecraft.username.toLowerCase()}`;
    const registered = await getSetting(db, key, false);
    const prompt = await waitForLine([a.registerPromptPattern, a.loginPromptPattern], a.promptTimeoutMs);
    let action = prompt ? (new RegExp(a.loginPromptPattern, 'i').test(prompt.line) ? 'login' : 'register') : registered ? 'login' : 'register';
    for (let i = 0; i < 3; i++) {
      // The specific answers are checked before the generic success one.
      const answer = waitForLine([a.alreadyRegisteredPattern, a.notRegisteredPattern, a.failurePattern, a.successPattern], a.replyTimeoutMs);
      await sendCommand(fill(action === 'register' ? a.registerCommand : a.loginCommand, { password: secrets.minecraft.password }));
      await logger.info('minecraft.login', `Sent the ${action === 'register' ? '/reg' : '/log'} command.`);
      const r = await answer;
      if (!r) {
        if (action === 'login') return; // some servers say nothing on success
        action = 'login';
        continue;
      }
      if (r.index === 0) {
        await setSetting(db, key, true);
        action = 'login';
      } else if (r.index === 1) action = 'register';
      else if (r.index === 2) throw new Error('the server refused the password (MINECRAFT_PASSWORD)');
      else {
        await setSetting(db, key, true);
        return;
      }
    }
    throw new Error('could not log in after 3 tries');
  }

  // ---- kit station -------------------------------------------------------------
  async function findStation({ force = false } = {}) {
    const nav = settings.navigation;
    const account = secrets.minecraft.username.toLowerCase();
    if (!force) {
      const saved = await getSetting(db, 'station', null);
      // A station found by another account is not reused (it may stand elsewhere).
      if (saved && saved.kits && saved.account === account && (!nav.home || sameBlock(saved.home, nav.home))) {
        station = saved;
        runtime.stationReady = true;
        return;
      }
    }
    const b = bot;
    if (!b || !runtime.ready) return;
    lastStationTry = Date.now();
    await settle(b);
    const origin = nav.home || b.entity.position;
    const result = detectStation({
      position: origin,
      yaw: b.entity.yaw,
      facing: nav.home ? nav.home.facing : null,
      blockAt: (p) => b.blockAt(new Vec3(p.x, p.y, p.z)),
      kits: settings.kits,
      scanDistance: nav.scanDistance
    });
    if (!result.ok) {
      runtime.stationReady = false;
      const msg = result.ambiguous
        ? 'The kit chests fit more than one orientation. Keep the side behind the bot free of chests, barrels and shulker boxes, then run /kitbot recalibrate.'
        : `Kit chests not found (${result.missing.join(', ')}). Log in as ${secrets.minecraft.username}, stand on the bot's block with the TOTEM chest on your left, PVP on your right and GRIEF in front (within ${nav.scanDistance} blocks), log out there, then run /kitbot recalibrate. The bot also retries by itself every 2 minutes.`;
      if (msg !== lastStationError) await logger.error('station.missing', msg);
      lastStationError = msg;
      return;
    }
    // Explicit coordinates in the settings win over detected ones.
    for (const [name, k] of Object.entries(result.kits)) {
      if (settings.kits[name].container) k.container = settings.kits[name].container;
      if (settings.kits[name].standAt) k.standAt = settings.kits[name].standAt;
    }
    station = { account, home: result.home, kits: result.kits, detectedAt: Date.now() };
    await setSetting(db, 'station', station);
    runtime.stationReady = true;
    lastStationError = null;
    // Coordinates stay out of the console: Actions logs can be public.
    await logger.info('station.found', `Kit chests found (${describeStation(station, settings.kits)})${result.turned ? '; the orientation was worked out from the chests' : ''}.`);
    queue.poke();
  }

  const sameBlock = (a, b) => a && b && Math.floor(a.x) === Math.floor(b.x) && Math.floor(a.y) === Math.floor(b.y) && Math.floor(a.z) === Math.floor(b.z);

  async function settle(b) {
    await Promise.race([b.waitForChunksToLoad().catch(() => {}), new Promise((r) => setTimeout(r, 15000))]);
    let last = b.entity.position.clone();
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (b.entity.position.distanceTo(last) < 0.01) return;
      last = b.entity.position.clone();
    }
  }

  // ---- idle behaviour of a player ----------------------------------------------------
  // Glances around now and then and turns back, so the bot is not frozen
  // (AFK kicks). Never during a delivery or while detecting the station.
  function idle(b) {
    let busy = false;
    const timer = setInterval(async () => {
      if (busy || bot !== b || !runtime.ready || queue.current() || b.currentWindow || !b.entity || Date.now() - lastStationTry < 20000) return;
      busy = true;
      const { yaw, pitch } = b.entity;
      try {
        await b.look(yaw + (Math.random() - 0.5) * 0.8, Math.max(-0.4, Math.min(0.4, pitch + (Math.random() - 0.5) * 0.4)));
        if (Math.random() < 0.3) b.swingArm();
        await new Promise((r) => setTimeout(r, 800 + Math.random() * 1200));
        if (bot === b && !queue.current()) await b.look(yaw, pitch);
      } catch {
        // disconnected
      } finally {
        busy = false;
      }
    }, 20000 + Math.floor(Math.random() * 20000));
    b.once('end', () => clearInterval(timer));
  }

  // ---- connection --------------------------------------------------------------------
  function scheduleReconnect(reason) {
    if (stopping || reconnectTimer) return;
    const delay = Math.min(300000, 5000 * 2 ** Math.min(reconnectAttempt, 6));
    reconnectAttempt++;
    logger.warn('minecraft.reconnect', `Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempt}): ${reason}`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (stopping) return;
    abort = new AbortController();
    const controller = abort;
    const b = mineflayer.createBot({
      host: secrets.minecraft.host,
      port: secrets.minecraft.port,
      username: secrets.minecraft.username,
      auth: secrets.minecraft.auth,
      version: secrets.minecraft.version || false,
      hideErrors: true,
      checkTimeoutInterval: 60000,
      respawn: true
    });
    bot = b;
    b.loadPlugin(pathfinder);
    numberBlockInteractions(b._client);
    attachChat(b);
    let spawned = false;
    let stableTimer = null;

    b.once('login', () => {
      runtime.connected = true;
      logger.info('minecraft.connected', `Connected to ${secrets.minecraft.host} as ${b.username}.`);
    });

    b.once('spawn', async () => {
      spawned = true;
      try {
        await login();
        await new Promise((r) => setTimeout(r, settings.auth.postLoginDelayMs));
        for (const cmd of settings.auth.postLoginCommands) await sendCommand(cmd);
        runtime.ready = true;
        lastChatAt = Date.now();
        silenceWarned = false;
        await findStation();
        if (b.inventory.emptySlotCount() < 2) await logger.warn('inventory.full', `The bot inventory is almost full (${b.inventory.emptySlotCount()} free slots): log in as ${b.username} and empty it.`);
        await logger.info('minecraft.ready', runtime.stationReady ? 'Logged in. Reading the chat for !kit and ready to deliver.' : 'Logged in and reading the chat, but deliveries wait until the kit chests are found.');
        stableTimer = setTimeout(() => (reconnectAttempt = 0), 60000);
        idle(b);
        queue.poke();
      } catch (e) {
        await logger.error('minecraft.login', `Login failed: ${e.message}`);
        b.quit('login failed');
      }
    });

    b.on('death', () => {
      if (!delivery.isReturning() && spawned) logger.warn('minecraft.death', 'The bot died.');
      setTimeout(() => {
        if (bot === b && !b.isAlive) {
          try {
            b.respawn();
          } catch {
            // disconnected
          }
        }
      }, 5000);
    });

    b.on('kicked', (reason) => {
      const text = chat.cleanText(chat.componentText(typeof reason === 'string' ? reason : JSON.stringify(reason)));
      logger.warn('minecraft.kicked', `Kicked: ${text.slice(0, 300)}`);
      if (new RegExp(settings.server.stopOnKickPattern, 'i').test(text)) {
        stopping = true;
        logger.error('minecraft.stopped', 'The kick says bots are not allowed or the account is banned: not reconnecting.');
      }
    });

    b.on('error', (e) => logger.error('minecraft.error', `Connection error: ${e.message}`));

    b.on('end', (reason) => {
      clearTimeout(stableTimer);
      controller.abort();
      runtime.connected = false;
      runtime.ready = false;
      if (bot === b) bot = null;
      logger.warn('minecraft.disconnected', `Disconnected: ${reason || 'unknown reason'}`);
      scheduleReconnect(reason || 'connection ended');
    });
  }

  // ---- shared state (pause, maintenance, reload, /kitbot say) ---------------------------------
  async function flushOutbox() {
    if (!runtime.ready) return;
    const now = Date.now();
    await db.run("UPDATE chat_outbox SET sent_at = ?, error = 'expired' WHERE sent_at IS NULL AND created_at < ?", [now, now - 600000]);
    for (const row of await db.all('SELECT * FROM chat_outbox WHERE sent_at IS NULL ORDER BY id LIMIT 5')) {
      const text = clean(row.message);
      if (!text || text.startsWith('/')) {
        await db.run("UPDATE chat_outbox SET sent_at = ?, error = 'refused' WHERE id = ?", [Date.now(), row.id]);
        continue;
      }
      try {
        await send(text);
      } catch {
        return;
      }
      await db.run('UPDATE chat_outbox SET sent_at = ? WHERE id = ?', [Date.now(), row.id]);
      await logger.info('chat.sent', `Said in the Minecraft chat (for <@${row.requested_by}>): ${text}`);
    }
  }

  async function refresh() {
    await flushOutbox();
    runtime.paused = !!(await getSetting(db, 'paused', false));
    runtime.maintenance = !!(await getSetting(db, 'maintenance', false));
    const recalibrate = await getSetting(db, 'station_recalibrate_at', null);
    if (lastRecalibrate === null) lastRecalibrate = recalibrate;
    else if (recalibrate !== lastRecalibrate && runtime.ready && !queue.current()) {
      lastRecalibrate = recalibrate;
      await logger.admin('station.recalibrate', 'Looking for the kit chests again from where the bot stands.');
      await findStation({ force: true });
    }
    if (!runtime.stationReady && runtime.ready && !queue.current() && Date.now() - lastStationTry > 120000) await findStation({ force: true });
    const reload = await getSetting(db, 'reload_requested_at', null);
    if (lastReload === null) lastReload = reload;
    else if (reload !== lastReload) {
      lastReload = reload;
      const next = loadSettings();
      if (next.errors.length) await logger.error('config.reload', `Reload refused: ${next.errors.join('; ')}`);
      else {
        settings = next.settings;
        compiled = compile(settings);
        await logger.admin('config.reload', 'The Minecraft bot reloaded its settings.');
      }
    }
  }

  async function heartbeat() {
    if (runtime.ready && !silenceWarned && Date.now() - lastChatAt > 15 * 60000) {
      silenceWarned = true;
      await logger.warn('chat.silent', 'No chat message at all for 15 minutes. Check in game that the bot is really in the world (not stuck in a lobby or queue).');
    } else if (silenceWarned && Date.now() - lastChatAt < 60000) silenceWarned = false;
    const cur = queue.current();
    await setStatus(db, 'minecraft', {
      ...runtime,
      username: bot ? bot.username : secrets.minecraft.username,
      online: onlineNames().length,
      currentRequest: cur ? { id: cur.id, kit: cur.kit, player: cur.mc_username } : null,
      reconnectAttempt
    });
  }

  async function start() {
    await recoverInterrupted(db, { maxAttempts: settings.limits.maxAttempts, logger });
    await refresh();
    timers.push(setInterval(() => refresh().catch((e) => logger.error('runtime.refresh', e.message)), 3000));
    timers.push(setInterval(() => heartbeat().catch(() => {}), 10000));
    queue.start();
    connect();
    await heartbeat();
  }

  async function stop() {
    stopping = true;
    clearTimeout(reconnectTimer);
    timers.forEach(clearInterval);
    const stopped = queue.stop();
    const later = (ms, value) => {
      let t;
      const p = new Promise((r) => (t = setTimeout(() => r(value), ms)));
      return { p, cancel: () => clearTimeout(t) };
    };
    // Let a delivery in progress finish (up to 45s), then abort it.
    const grace = later(45000, true);
    if (await Promise.race([stopped.then(() => false), grace.p])) abort?.abort();
    grace.cancel();
    const last = later(10000);
    await Promise.race([stopped, last.p]);
    last.cancel();
    runtime.ready = false;
    if (bot) {
      const b = bot;
      await new Promise((resolve) => {
        b.once('end', resolve);
        // quit() exists only once Mineflayer has loaded its plugins.
        if (typeof b.quit === 'function') b.quit('shutting down');
        else b.end('shutting down');
        setTimeout(resolve, 5000).unref();
      });
    }
    await setStatus(db, 'minecraft', { connected: false, ready: false, stoppedAt: Date.now() }).catch(() => {});
    await logger.info('minecraft.stopped', 'Minecraft bot stopped.');
  }

  return { start, stop, runtime, queue, getSettings, getBot: () => bot };
}

module.exports = { createMinecraftBot, fill, clean };
