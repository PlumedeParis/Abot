'use strict';

// Minecraft side: connection, server login (AuthMe-style /reg and /log),
// chat command intake, outgoing chat throttling, reconnection and the
// delivery worker.

const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const { getSetting, setSetting, setStatus } = require('./database');
const { loadSettings } = require('./config');
const { createRequestHandler, compilePatterns, parseChatLine } = require('./requests');
const { createQueue, recoverInterrupted } = require('./queue');
const { createKitService } = require('./kits');
const linking = require('./linking');

const MC_MAX_CHAT = 256;

function sanitizeOutgoing(text, maxLength) {
  return String(text)
    .replace(/[\u0000-\u001f\u007f§]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, Math.min(maxLength, MC_MAX_CHAT));
}

function fill(template, values) {
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in values ? values[k] : m));
}

function createMinecraftBot({ config, db, logger, checkMembership, onSettingsReloaded = () => {} }) {
  const { secrets } = config;
  let settings = config.settings;
  const getSettings = () => settings;

  const runtime = { paused: false, maintenance: false, minecraftReady: false, connected: false };
  let bot = null;
  let stopping = false;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let abortController = null;
  let lastReloadAt = null;
  let chatPatterns = compilePatterns(settings.chat.patterns);
  const chatLineListeners = new Set();
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
    }
  });

  const queue = createQueue({
    db,
    getSettings,
    logger,
    canRun: () => runtime.minecraftReady && !runtime.paused && !runtime.maintenance && !stopping,
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
    deliver: (req, ctx) =>
      kitService.deliver(req, { ...ctx, notify: (msg) => reply(req.mc_username, msg) }, abortController ? abortController.signal : null),
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
        await logger.info('minecraft.ready', 'Logged in and ready to deliver kits.');
        stableTimer = setTimeout(() => (reconnectAttempt = 0), 60000);
        queue.poke();
      } catch (e) {
        await logger.error('minecraft.auth', `Login failed: ${e.message}`);
        current.quit('login failed');
      }
    });

    current.on('messagestr', (line, position) => {
      if (position === 'game_info') return; // action bar
      logger.debug('chat.line', line); // console only, with logging.consoleLevel = "DEBUG"
      for (const fn of [...chatLineListeners]) {
        try {
          fn(line);
        } catch {
          // listener errors must not break chat handling
        }
      }
      if (!runtime.minecraftReady) return;
      const parsed = parseChatLine(line, chatPatterns);
      if (!parsed || parsed.username === current.username) return;
      handleChat(parsed.username, parsed.message).catch((e) => logger.error('request.error', `Error handling a command from ${parsed.username}: ${e.message}`));
    });

    current.on('death', () => logger.warn('minecraft.death', 'The bot died.'));

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

  // ---- shared state refresh (pause / maintenance / reload from Discord) ----
  async function refreshRuntime() {
    runtime.paused = !!(await getSetting(db, 'paused', false));
    runtime.maintenance = !!(await getSetting(db, 'maintenance', false));
    const reloadAt = await getSetting(db, 'reload_requested_at', null);
    if (lastReloadAt === null) lastReloadAt = reloadAt;
    else if (reloadAt !== lastReloadAt) {
      lastReloadAt = reloadAt;
      try {
        const { settings: next, errors } = loadSettings();
        if (errors.length) throw new Error(errors.join('; '));
        settings = next;
        chatPatterns = compilePatterns(settings.chat.patterns);
        onSettingsReloaded(settings);
        await logger.admin('config.reloaded', 'Minecraft bot reloaded its settings.');
      } catch (e) {
        await logger.error('config.reload_failed', `Settings reload failed, keeping the previous settings: ${e.message}`);
      }
    }
  }

  async function heartbeat() {
    const cur = queue.current();
    await setStatus(db, 'minecraft', {
      connected: runtime.connected,
      ready: runtime.minecraftReady,
      username: bot ? bot.username : secrets.minecraft.username,
      paused: runtime.paused,
      maintenance: runtime.maintenance,
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

module.exports = { createMinecraftBot, sanitizeOutgoing, fill };
