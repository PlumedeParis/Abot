'use strict';

// Minecraft side: connection, server login (AuthMe-style /reg and /log),
// chat command intake, outgoing chat throttling, reconnection and the
// delivery worker.

const mineflayer = require('mineflayer');
const { Vec3 } = require('vec3');
const { pathfinder } = require('mineflayer-pathfinder');
const { getSetting, setSetting, setStatus } = require('./database');
const { loadSettings } = require('./config');
const { createRequestHandler, compilePatterns, parseChatLine, parseSignedChat } = require('./requests');
const { createQueue, recoverInterrupted } = require('./queue');
const { createKitService, numberBlockInteractions } = require('./kits');
const linking = require('./linking');
const { recordStock } = require('./stock');
const { detectStation, applyStation, describeStation } = require('./station');

const MC_MAX_CHAT = 256;

function sanitizeOutgoing(text, maxLength) {
  return String(text)
    .replace(/[\u0000-\u001f\u007f§]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, Math.min(maxLength, MC_MAX_CHAT));
}

function deliveryAnnouncement(template, req) {
  if (!template) return '';
  return fill(template, { player: req.mc_username, kit: req.kit });
}

function fill(template, values) {
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in values ? values[k] : m));
}

function createMinecraftBot({ config, db, logger, checkMembership, onSettingsReloaded = () => {} }) {
  const { secrets } = config;
  let settings = config.settings;
  let baseSettings = config.settings; // settings before the detected station is applied
  const getSettings = () => settings;

  const runtime = { paused: false, maintenance: false, minecraftReady: false, connected: false, stationReady: !!settings.navigation.home };
  let station = null; // auto-detected kit station (see src/station.js)
  let lastRecalibrateAt = null;
  let lastStationError = null;
  let lastStationAttempt = 0;
  let bot = null;
  let stopping = false;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let abortController = null;
  let lastReloadAt = null;
  let chatPatterns = compilePatterns(settings.chat.patterns);
  const chatLineListeners = new Set();
  let lastChatAt = 0;
  let lastUnreadableAt = 0;
  let chatSilenceWarned = false;
  const mentionsCommand = (line) => {
    const lower = line.toLowerCase();
    return lower.includes(settings.chat.kitCommand.toLowerCase()) || lower.includes(settings.chat.linkCommand.toLowerCase());
  };
  const intervals = [];

  // ---- outgoing chat (throttled to avoid server anti-spam kicks) ----------
  const outbox = [];
  let sending = false;
  function sendRaw(text) {
    return new Promise((resolve, reject) => {
      outbox.push({ text, resolve, reject });
      pump();
    });
  }
  async function pump() {
    if (sending) return;
    sending = true;
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
    sending = false;
  }

  const sendCommand = (cmd) => sendRaw(sanitizeOutgoing(cmd, MC_MAX_CHAT));

  async function reply(username, message) {
    if (!/^[A-Za-z0-9_]{1,16}$/.test(username)) return;
    const text = sanitizeOutgoing(message, settings.chat.maxLength);
    try {
      await sendRaw(fill(settings.chat.replyCommand, { player: username, message: text }));
    } catch {
      // offline or disconnected: the event is still logged
    }
  }

  function getOnlinePlayer(username) {
    if (!bot || !bot.players) return null;
    const p = bot.players[username];
    if (!p) return null;
    return { username: p.username, uuid: p.uuid || null };
  }

  const kitService = createKitService({
    getBot: () => bot,
    getSettings,
    logger,
    sendCommand,
    onChatLine: (fn) => {
      chatLineListeners.add(fn);
      return () => chatLineListeners.delete(fn);
    },
    onStock: (kit, left) => recordStock(db, logger, { kit, left, lowThreshold: settings.stock.lowThreshold })
  });

  const queue = createQueue({
    db,
    getSettings,
    logger,
    canRun: () => runtime.minecraftReady && runtime.stationReady && !runtime.paused && !runtime.maintenance && !stopping,
    verify: async (req) => {
      const link = await linking.getActiveLinkByUsername(db, req.mc_username);
      if (!link || link.discord_id !== req.discord_id) return { ok: false, reason: 'account link no longer active' };
      const m = await checkMembership(req.discord_id);
      if (m.status === 'unavailable') return { ok: false, retryLater: true, reason: 'Discord membership verification unavailable' };
      if (m.status !== 'member') {
        if (m.status === 'not_member') {
          await linking.revokeLinks(db, req.discord_id, 'left the Discord server');
          await logger.warn('link.revoked', `Revoked link ${req.mc_username} <-> <@${req.discord_id}>: no longer a member of the Discord server.`);
        }
        return { ok: false, reason: `Discord check failed (${m.status})`, playerMessage: 'Your request was cancelled: you are no longer verified in our Discord server.' };
      }
      if (!getOnlinePlayer(req.mc_username)) return { ok: false, reason: 'player is offline' };
      return { ok: true };
    },
    deliver: async (req, ctx) => {
      const result = await kitService.deliver(req, { ...ctx, notify: (msg) => reply(req.mc_username, msg) }, abortController ? abortController.signal : null);
      if (result && result.outcome === 'delivered') await announceDelivery(req);
      return result;
    },
    notify: (req, msg) => (getOnlinePlayer(req.mc_username) ? reply(req.mc_username, msg) : Promise.resolve())
  });

  const handleChat = createRequestHandler({
    db,
    getSettings,
    getRuntime: () => runtime,
    logger,
    checkMembership,
    getOnlinePlayer,
    reply,
    onQueued: () => queue.poke()
  });

  // ---- server login (AuthMe-style) ----------------------------------------
  function waitForLine(patterns, timeoutMs) {
    return new Promise((resolve) => {
      const res = patterns.map((p) => (p ? new RegExp(p, 'i') : null));
      const timer = setTimeout(() => {
        chatLineListeners.delete(listener);
        resolve(null);
      }, timeoutMs);
      const listener = (line) => {
        const idx = res.findIndex((re) => re && re.test(line));
        if (idx >= 0) {
          clearTimeout(timer);
          chatLineListeners.delete(listener);
          resolve({ index: idx, line });
        }
      };
      chatLineListeners.add(listener);
    });
  }

  async function authenticate() {
    const a = settings.auth;
    if (!a.enabled) return true;
    if (!secrets.minecraft.password) throw new Error('auth.enabled is true but MINECRAFT_PASSWORD is not set');
    const values = { password: secrets.minecraft.password };
    const registered = await getSetting(db, 'minecraft.registered', false);

    const prompt = await waitForLine([a.registerPromptPattern, a.loginPromptPattern], a.promptTimeoutMs);
    let action;
    if (prompt) action = new RegExp(a.loginPromptPattern, 'i').test(prompt.line) ? 'login' : 'register';
    else action = registered ? 'login' : 'register';

    // Specific replies are checked before the generic success pattern.
    for (let step = 0; step < 3; step++) {
      const outcome = waitForLine([a.alreadyRegisteredPattern, a.notRegisteredPattern, a.failurePattern, a.successPattern], a.successTimeoutMs);
      await sendCommand(fill(action === 'register' ? a.registerCommand : a.loginCommand, values));
      await logger.info('minecraft.auth', `Sent ${action} command to the server.`);
      const r = await outcome;
      if (!r) {
        // Some servers print nothing on success. Treat silence as success only for login.
        if (action === 'login') return true;
        await logger.warn('minecraft.auth', 'No reply to the register command; trying to log in.');
        action = 'login';
        continue;
      }
      if (r.index === 0) {
        await setSetting(db, 'minecraft.registered', true);
        action = 'login';
        continue;
      }
      if (r.index === 1) {
        action = 'register';
        continue;
      }
      if (r.index === 2) throw new Error('the server rejected the login password');
      if (!registered) await setSetting(db, 'minecraft.registered', true);
      return true;
    }
    return false;
  }

  // ---- connection lifecycle -------------------------------------------------
  function scheduleReconnect(reason) {
    if (stopping || reconnectTimer) return;
    const delay = Math.min(300000, 5000 * 2 ** Math.min(reconnectAttempt, 6));
    reconnectAttempt++;
    logger.warn('minecraft.reconnect', `Reconnecting to Minecraft in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempt}): ${reason}`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (stopping) return;
    abortController = new AbortController();
    const controller = abortController;
    let spawnedOnce = false;
    let stableTimer = null;

    bot = mineflayer.createBot({
      host: secrets.minecraft.host,
      port: secrets.minecraft.port,
      username: secrets.minecraft.username,
      auth: secrets.minecraft.auth,
      version: secrets.minecraft.version,
      hideErrors: true,
      checkTimeoutInterval: 60000,
      respawn: true
    });
    bot.loadPlugin(pathfinder);
    numberBlockInteractions(bot._client);
    const current = bot;

    current.once('login', () => {
      runtime.connected = true;
      logger.info('minecraft.connected', `Connected to the Minecraft server as ${current.username}.`);
    });

    current.on('spawn', async () => {
      if (spawnedOnce) return;
      spawnedOnce = true;
      try {
        const ok = await authenticate();
        if (!ok) throw new Error('could not complete the server login');
        await new Promise((r) => setTimeout(r, settings.auth.postLoginDelayMs));
        for (const cmd of settings.auth.postLoginCommands) await sendCommand(cmd);
        runtime.minecraftReady = true;
        lastChatAt = Date.now();
        chatSilenceWarned = false;
        await ensureStation();
        const free = current.inventory.emptySlotCount();
        if (free < 2) {
          await logger.warn('inventory.full', `The bot has only ${free} free inventory slot(s), so it cannot take kits out of the chests. Log in as the bot and empty its inventory.`);
        }
        await logger.info('minecraft.ready', runtime.stationReady ? 'Logged in and ready to deliver kits.' : 'Logged in, but kit deliveries are disabled until the kit station is found.');
        stableTimer = setTimeout(() => (reconnectAttempt = 0), 60000);
        queue.poke();
      } catch (e) {
        await logger.error('minecraft.auth', `Login failed: ${e.message}`);
        current.quit('login failed');
      }
    });

    current.on('messagestr', (line, position, msg, sender) => {
      if (position === 'game_info') return; // action bar
      lastChatAt = Date.now();
      logger.debug('chat.line', line); // console only, with logging.consoleLevel = "DEBUG"
      for (const fn of [...chatLineListeners]) {
        try {
          fn(line);
        } catch {
          // listener errors must not break chat handling
        }
      }
      if (!runtime.minecraftReady) return;
      // Signed player chat carries the sender's UUID: use it when the player is known,
      // whatever the server's chat format looks like.
      const signer = position === 'chat' && sender ? Object.values(current.players).find((p) => p.uuid === sender) : null;
      const parsed = (signer && parseSignedChat(line, signer.username)) || parseChatLine(line, chatPatterns);
      if (!parsed) {
        // A command we could not attribute to a player: show the raw line so the chat patterns can be fixed.
        if (mentionsCommand(line) && Date.now() - lastUnreadableAt > 30000) {
          lastUnreadableAt = Date.now();
          logger.warn('chat.unreadable', `Saw a command in the chat but could not tell who sent it (chat type: ${position}). Line: "${line.slice(0, 200)}"`);
        }
        return;
      }
      if (parsed.username === current.username) return;
      handleChat(parsed.username, parsed.message).catch((e) => logger.error('request.error', `Error handling a command from ${parsed.username}: ${e.message}`));
    });

    current.on('death', () => {
      if (kitService.isReturning()) logger.debug('minecraft.death', 'Respawning to return to base.');
      else logger.warn('minecraft.death', 'The bot died.');
      // Mineflayer respawns by itself; make sure it did, or the bot stays on the death screen.
      setTimeout(() => {
        if (bot === current && !current.isAlive) {
          logger.warn('minecraft.death', 'The bot is still dead after 5s; asking the server to respawn it.');
          try {
            current.respawn();
          } catch {
            // disconnected
          }
        }
      }, 5000);
    });

    current.on('kicked', (reason) => {
      const text = typeof reason === 'string' ? reason : JSON.stringify(reason);
      logger.warn('minecraft.kicked', `Kicked from the server: ${text.slice(0, 300)}`);
      if (new RegExp(settings.server.stopOnKickPattern, 'i').test(text)) {
        stopping = true;
        logger.error('minecraft.stopped', 'The kick message indicates bots are not allowed or the account is banned. Not reconnecting; check the server rules.');
      }
    });

    current.on('error', (err) => logger.error('minecraft.error', `Minecraft connection error: ${err.message}`));

    current.on('end', (reason) => {
      clearTimeout(stableTimer);
      controller.abort();
      runtime.connected = false;
      runtime.minecraftReady = false;
      if (bot === current) bot = null;
      logger.warn('minecraft.disconnected', `Disconnected from Minecraft: ${reason || 'unknown reason'}`);
      scheduleReconnect(reason || 'connection ended');
    });
  }

  // Public chat line after a confirmed delivery; never affects the delivery itself.
  async function announceDelivery(req) {
    const text = deliveryAnnouncement(settings.chat.deliveryAnnouncement, req);
    if (!text) return;
    try {
      await sendRaw(sanitizeOutgoing(text, MC_MAX_CHAT));
    } catch {
      // disconnected: skip the announcement
    }
  }

  // Messages queued from Discord with /kitbot say. Old ones (bot offline for
  // a while) are dropped instead of being flooded into the chat later.
  async function flushChatOutbox() {
    if (!runtime.minecraftReady) return;
    const now = Date.now();
    await db.run("UPDATE chat_outbox SET sent_at = ?, error = 'expired' WHERE sent_at IS NULL AND created_at < ?", [now, now - 10 * 60000]);
    const rows = await db.all('SELECT * FROM chat_outbox WHERE sent_at IS NULL ORDER BY id LIMIT 5');
    for (const row of rows) {
      const text = sanitizeOutgoing(row.message, MC_MAX_CHAT);
      if (!text || text.startsWith('/')) {
        await db.run("UPDATE chat_outbox SET sent_at = ?, error = 'refused' WHERE id = ?", [Date.now(), row.id]);
        continue;
      }
      try {
        await sendRaw(text);
        await db.run('UPDATE chat_outbox SET sent_at = ? WHERE id = ?', [Date.now(), row.id]);
        await logger.info('chat.sent', `Sent to the Minecraft chat (requested by <@${row.requested_by}>): ${text}`);
      } catch {
        return; // disconnected: retry on the next refresh
      }
    }
  }

  // ---- shared state refresh (pause / maintenance / reload from Discord) ----
  async function refreshRuntime() {
    await flushChatOutbox();
    const recalibrateAt = await getSetting(db, 'station_recalibrate_at', null);
    if (lastRecalibrateAt === null) lastRecalibrateAt = recalibrateAt;
    else if (recalibrateAt !== lastRecalibrateAt && runtime.minecraftReady && !queue.current()) {
      lastRecalibrateAt = recalibrateAt;
      await logger.admin('station.recalibrate', 'Re-detecting the kit station from the bot position.');
      await ensureStation({ force: true });
    }
    // Retry every 2 minutes while the station is missing (e.g. chests being placed).
    if (!runtime.stationReady && runtime.minecraftReady && !queue.current() && Date.now() - lastStationAttempt > 120000) {
      await ensureStation({ force: true });
    }
    runtime.paused = !!(await getSetting(db, 'paused', false));
    runtime.maintenance = !!(await getSetting(db, 'maintenance', false));
    const reloadAt = await getSetting(db, 'reload_requested_at', null);
    if (lastReloadAt === null) lastReloadAt = reloadAt;
    else if (reloadAt !== lastReloadAt) {
      lastReloadAt = reloadAt;
      try {
        const { settings: next, errors } = loadSettings();
        if (errors.length) throw new Error(errors.join('; '));
        baseSettings = next;
        settings = station ? applyStation(next, station) : next;
        chatPatterns = compilePatterns(settings.chat.patterns);
        onSettingsReloaded(settings);
        await logger.admin('config.reloaded', 'Minecraft bot reloaded its settings.');
      } catch (e) {
        await logger.error('config.reload_failed', `Settings reload failed, keeping the previous settings: ${e.message}`);
      }
    }
  }

  // ---- kit station ------------------------------------------------------------
  async function waitUntilSettled(b) {
    await Promise.race([b.waitForChunksToLoad().catch(() => {}), new Promise((r) => setTimeout(r, 15000))]);
    // Wait until the server has finished moving the bot (login teleports).
    let last = b.entity.position.clone();
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (b.entity.position.distanceTo(last) < 0.01) return;
      last = b.entity.position.clone();
    }
  }

  async function ensureStation({ force = false } = {}) {
    if (settings.navigation.home && !station) {
      runtime.stationReady = true; // configured explicitly
      return;
    }
    if (!settings.navigation.autoDetect) return;
    if (!force) {
      const stored = await getSetting(db, 'station', null);
      if (stored) {
        station = stored;
        settings = applyStation(settings, station);
        runtime.stationReady = true;
        return;
      }
    }
    const b = bot;
    if (!b || !runtime.minecraftReady) return;
    lastStationAttempt = Date.now();
    await waitUntilSettled(b);
    const result = detectStation({
      position: b.entity.position,
      yaw: b.entity.yaw,
      blockAt: (p) => b.blockAt(new Vec3(p.x, p.y, p.z)),
      kits: settings.kits,
      scanDistance: settings.navigation.scanDistance
    });
    if (!result.ok) {
      runtime.stationReady = false;
      const msg = result.ambiguous
        ? 'Kit station is ambiguous: the chests around the bot match more than one orientation. Keep the side behind the bot (opposite the grief chest) free of chests, barrels and shulker boxes, then run /kitbot recalibrate.'
        : `Kit station not found: no chest for ${result.missing.join(', ')}. Seen from the bot's spot, the totem chest must be on its left, the pvp chest on its right and the grief chest in front, each in a straight line within ${settings.navigation.scanDistance} blocks, with no chest, barrel or shulker box behind it. Then run /kitbot recalibrate (it also retries by itself every 2 minutes).`;
      if (msg !== lastStationError) await logger.error('station.missing', msg);
      lastStationError = msg;
      return;
    }
    // Detection starts from the configured settings, not from an older station.
    station = { home: result.home, kits: result.kits, detectedAt: Date.now() };
    settings = applyStation(baseSettings, station);
    await setSetting(db, 'station', station);
    runtime.stationReady = true;
    lastStationError = null;
    // Coordinates are kept out of the logs: GitHub Actions logs may be readable by others.
    await logger.info('station.detected', `Kit station detected (${describeStation(station)})${result.facingCorrected ? '; the bot was not facing that way, so its orientation was worked out from the chests' : ''}.`);
    queue.poke();
  }

  async function heartbeat() {
    // No chat at all for 5 minutes: the server is not sending the chat to the bot
    // (e.g. still in a lobby or queue), so it cannot see any command.
    if (runtime.minecraftReady && !chatSilenceWarned && Date.now() - lastChatAt > 5 * 60000) {
      chatSilenceWarned = true;
      await logger.warn('chat.silent', 'The bot has not received any chat message for 5 minutes, so it cannot see !kit. Check in game that it is really on the server (not in a lobby or queue) and that the chat is visible to it.');
    } else if (chatSilenceWarned && Date.now() - lastChatAt < 60000) {
      chatSilenceWarned = false;
      await logger.info('chat.silent', 'The bot receives the chat again.');
    }
    const cur = queue.current();
    await setStatus(db, 'minecraft', {
      connected: runtime.connected,
      ready: runtime.minecraftReady,
      username: bot ? bot.username : secrets.minecraft.username,
      paused: runtime.paused,
      maintenance: runtime.maintenance,
      stationReady: runtime.stationReady,
      currentRequest: cur ? { id: cur.id, kit: cur.kit, player: cur.mc_username } : null,
      reconnectAttempt
    });
  }

  async function start() {
    if (!settings.server.botsAllowedConfirmed) {
      throw new Error('server.botsAllowedConfirmed is false. Read the server rules and confirm that automated bots are allowed before enabling the Minecraft bot.');
    }
    await recoverInterrupted(db, { maxAttempts: settings.limits.maxAttempts, logger });
    await refreshRuntime();
    intervals.push(setInterval(() => refreshRuntime().catch((e) => logger.error('runtime.refresh', e.message)), 3000));
    intervals.push(setInterval(() => heartbeat().catch(() => {}), 10000));
    queue.start();
    connect();
    await heartbeat();
  }

  async function stop() {
    stopping = true;
    clearTimeout(reconnectTimer);
    intervals.forEach(clearInterval);
    // Let a delivery in progress finish (up to 45s), then abort it.
    const stopped = queue.stop();
    const timedOut = await Promise.race([stopped.then(() => false), new Promise((r) => setTimeout(() => r(true), 45000))]);
    if (timedOut && abortController) abortController.abort();
    await Promise.race([stopped, new Promise((r) => setTimeout(r, 10000))]);
    runtime.minecraftReady = false;
    if (bot) {
      const b = bot;
      await new Promise((resolve) => {
        b.once('end', resolve);
        b.quit('shutting down');
        setTimeout(resolve, 5000);
      });
    }
    await setStatus(db, 'minecraft', { connected: false, ready: false, stoppedAt: Date.now() }).catch(() => {});
    await logger.info('minecraft.shutdown', 'Minecraft bot stopped.');
  }

  return { start, stop, runtime, queue, getSettings };
}

module.exports = { createMinecraftBot, sanitizeOutgoing, fill, deliveryAnnouncement };
