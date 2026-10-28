'use strict';

// Configuration.
//   Secrets (passwords, tokens, database URL) come only from environment
//   variables: GitHub Secrets on Actions, or a local .env file.
//   Settings (kits, limits, chat, delivery) are built-in defaults, optionally
//   overridden by config.json or by the KITBOT_CONFIG_JSON variable.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const KIT_NAMES = ['totem', 'pvp', 'grief'];
const DIRECTIONS = ['left', 'right', 'forward', 'backward'];
// Minecraft F3 yaw in degrees for each cardinal facing.
const FACINGS = { south: 0, west: 90, north: 180, east: -90 };

const DEFAULTS = {
  server: {
    // Set to true by the workflow checkbox (KITBOT_BOTS_ALLOWED=true).
    botsAllowedConfirmed: false,
    version: '1.21.11',
    // A kick matching this stops the bot for good instead of reconnecting.
    stopOnKickPattern: '(banned|blacklisted|bots? (are )?not allowed)'
  },
  // AuthMe-style login on cracked servers: /reg on the first join, /log after.
  auth: {
    enabled: true,
    registerCommand: '/reg {password} {password}',
    loginCommand: '/log {password}',
    registerPromptPattern: '/reg(ister)?\\b',
    loginPromptPattern: '/l(og|ogin)?\\b',
    successPattern: '(success|logged in)',
    alreadyRegisteredPattern: 'already (been )?registered',
    notRegisteredPattern: "(isn't|is not|not) registered",
    failurePattern: '(wrong|incorrect|invalid) password',
    promptTimeoutMs: 10000,
    replyTimeoutMs: 15000,
    postLoginCommands: [],
    postLoginDelayMs: 3000
  },
  chat: {
    kitCommand: '!kit',
    linkCommand: '!link',
    replyCommand: '/msg {player} {message}',
    // Delay between two messages the bot sends (server anti-spam).
    minDelayMs: 1200,
    maxLength: 240,
    // Public line after each confirmed delivery ("" turns it off).
    deliveryAnnouncement: '{player} just got a {kit} kit from VoidKits! Get yours: !kit totem / pvp / grief',
    // Public message every intervalMinutes ("" turns it off).
    // Invite to the Discord server, sent to players who have not linked their account yet.
    discordInvite: 'https://discord.gg/VTX6khDexE',
    advertisement: { message: 'order a kit by typing !kit totem/pvp/grief', intervalMinutes: 30 },
    // Private message (chat.replyCommand) to each player who joins the server,
    // at most once every cooldownHours per player ("" turns it off). Players
    // already online when the bot logs in (its first joinGraceSeconds) are not "joining".
    welcome: { message: 'order a free kit by doing !kit totem/pvp/grief', cooldownHours: 6, joinGraceSeconds: 15 },
    perPlayerCommandIntervalMs: 3000,
    // Commands are only accepted from players who are in the tab list.
    requireOnlinePlayer: true,
    // Chat lines matching this (case-insensitive) are never commands, e.g.
    // messages relayed from a Discord server, whose authors are not in game.
    ignorePattern: '^\\[[^\\]]*discord[^\\]]*\\]',
    // Optional extra formats, tried first: anchored regexes with
    // (?<username>...) and (?<message>...) groups.
    patterns: []
  },
  limits: {
    cooldownMinutes: 10,
    dailyQuota: 10,
    quotaWindowHours: 24,
    globalPerMinute: 2,
    maxQueueSize: 20,
    maxQueueWaitMinutes: 30,
    maxAttempts: 2
  },
  linking: {
    maxLinksPerDiscord: 1,
    codeTtlMinutes: 10,
    usernameChangeCooldownDays: 30,
    maxFailedCodeAttemptsPerHour: 5,
    requiredRoleId: null
  },
  discord: {
    membershipTimeoutMs: 8000,
    reconcileIntervalMinutes: 30,
    logFlushIntervalSeconds: 5,
    confirmationTimeoutSeconds: 60
  },
  navigation: {
    // Find the kit chests around the bot after login (src/station.js).
    autoDetect: true,
    scanDistance: 6,
    // Set explicitly: { x, y, z, facing: "north" } (otherwise detected).
    home: null,
    returnHomeAfterDelivery: true,
    allowDigging: false,
    allowParkour: false,
    allowSprinting: true,
    arriveRadius: 1,
    timeoutMs: 60000,
    // Farther than this from home, the bot runs returnCommands instead of
    // walking (default /kill: respawn at the bed next to the base).
    farFromHomeBlocks: 32,
    returnCommands: ['/kill'],
    respawnWaitMs: 20000
  },
  delivery: {
    // "teleport": run commands (default /tpa), wait for the player to accept.
    // "drop": wait at the drop-off point (default: home) for the player.
    method: 'teleport',
    commands: ['/tpa {player}'],
    dropoff: null,
    instructions: 'Your {kit} kit is ready! Accept my teleport request with /tpaccept within 60 seconds.',
    playerRadius: 4,
    waitForPlayerMs: 60000,
    pickupTimeoutMs: 15000
  },
  stock: { lowThreshold: 5 },
  // Each kit is one item stack taken from its chest (default: a shulker box).
  kits: {
    totem: { direction: 'left', items: [{ nameRegex: 'shulker_box$', count: 1 }] },
    pvp: { direction: 'right', items: [{ nameRegex: 'shulker_box$', count: 1 }] },
    grief: { direction: 'forward', items: [{ nameRegex: 'shulker_box$', count: 1 }] }
  },
  logging: { retentionDays: 30, consoleLevel: 'INFO' }
};

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isPos = (v) => isObject(v) && isNum(v.x) && isNum(v.y) && isNum(v.z);

function deepMerge(base, override) {
  if (!isObject(base) || !isObject(override)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) out[k] = isObject(v) && isObject(base[k]) ? deepMerge(base[k], v) : v;
  return out;
}

function readSettingsJson(env) {
  const raw = (env.KITBOT_CONFIG_JSON || '').trim();
  if (raw) {
    // Raw JSON, or base64 (easier to paste as a secret).
    return { source: 'KITBOT_CONFIG_JSON', json: JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')) };
  }
  const file = path.resolve(ROOT, env.KITBOT_CONFIG || 'config.json');
  if (!fs.existsSync(file)) {
    if (env.KITBOT_CONFIG) throw new Error(`Configuration file not found: ${file}`);
    return { source: 'built-in defaults', json: {} };
  }
  return { source: path.basename(file), json: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

function validateSettings(s) {
  const errors = [];
  const positive = (where, v) => {
    if (!isNum(v) || v <= 0) errors.push(`${where} must be a positive number`);
  };
  const regex = (where, p) => {
    try {
      new RegExp(p, 'i');
    } catch (e) {
      errors.push(`${where} is not a valid regular expression (${e.message})`);
    }
  };
  for (const [k, v] of Object.entries(s.limits)) positive(`limits.${k}`, v);
  for (const k of ['maxLinksPerDiscord', 'codeTtlMinutes', 'usernameChangeCooldownDays', 'maxFailedCodeAttemptsPerHour']) positive(`linking.${k}`, s.linking[k]);
  positive('chat.maxLength', s.chat.maxLength);
  if (typeof s.chat.discordInvite !== 'string') errors.push('chat.discordInvite must be a link (or "")');
  if (!isObject(s.chat.advertisement) || typeof s.chat.advertisement.message !== 'string') errors.push('chat.advertisement must be { "message", "intervalMinutes" }');
  else if (s.chat.advertisement.message) positive('chat.advertisement.intervalMinutes', s.chat.advertisement.intervalMinutes);
  if (!isObject(s.chat.welcome) || typeof s.chat.welcome.message !== 'string') errors.push('chat.welcome must be { "message", "cooldownHours" }');
  else if (!isNum(s.chat.welcome.cooldownHours) || s.chat.welcome.cooldownHours < 0) errors.push('chat.welcome.cooldownHours must be 0 or more');
  for (const k of ['kitCommand', 'linkCommand']) if (!/^![a-z]{1,16}$/i.test(s.chat[k])) errors.push(`chat.${k} must look like "!kit"`);
  if (!s.chat.replyCommand.includes('{player}') || !s.chat.replyCommand.includes('{message}')) errors.push('chat.replyCommand must contain {player} and {message}');
  if (s.chat.ignorePattern) regex('chat.ignorePattern', s.chat.ignorePattern);
  if (!Array.isArray(s.chat.patterns)) errors.push('chat.patterns must be a list');
  else
    s.chat.patterns.forEach((p, i) => {
      regex(`chat.patterns[${i}]`, p);
      if (!String(p).startsWith('^') || !p.includes('(?<username>') || !p.includes('(?<message>')) {
        errors.push(`chat.patterns[${i}] must start with ^ and contain (?<username>...) and (?<message>...)`);
      }
    });
  for (const k of ['registerPromptPattern', 'loginPromptPattern', 'successPattern', 'alreadyRegisteredPattern', 'notRegisteredPattern', 'failurePattern']) regex(`auth.${k}`, s.auth[k]);
  regex('server.stopOnKickPattern', s.server.stopOnKickPattern);
  if (!Number.isInteger(s.stock.lowThreshold) || s.stock.lowThreshold < 0) errors.push('stock.lowThreshold must be a whole number');

  const home = s.navigation.home;
  if (home !== null) {
    if (!isPos(home)) errors.push('navigation.home must be { "x", "y", "z", "facing" }');
    else if (!(home.facing in FACINGS)) errors.push(`navigation.home.facing must be one of ${Object.keys(FACINGS).join(', ')}`);
  }
  if (!['teleport', 'drop'].includes(s.delivery.method)) errors.push('delivery.method must be "teleport" or "drop"');
  if (s.delivery.method === 'teleport' && (!Array.isArray(s.delivery.commands) || !s.delivery.commands.length)) errors.push('delivery.commands is required for the teleport method');
  if (s.delivery.dropoff !== null && !isPos(s.delivery.dropoff)) errors.push('delivery.dropoff must be { "x", "y", "z" } or null');

  for (const name of Object.keys(s.kits)) if (!KIT_NAMES.includes(name)) errors.push(`kits.${name}: unknown kit (allowed: ${KIT_NAMES.join(', ')})`);
  for (const name of KIT_NAMES) {
    const kit = s.kits[name];
    if (!isObject(kit)) {
      errors.push(`kits.${name} is missing`);
      continue;
    }
    if (!DIRECTIONS.includes(kit.direction)) errors.push(`kits.${name}.direction must be one of ${DIRECTIONS.join(', ')}`);
    if (kit.container !== undefined && kit.container !== null && !isPos(kit.container)) errors.push(`kits.${name}.container must be { "x", "y", "z" }`);
    if (kit.standAt !== undefined && kit.standAt !== null && !isPos(kit.standAt)) errors.push(`kits.${name}.standAt must be { "x", "y", "z" }`);
    if (!Array.isArray(kit.items) || !kit.items.length) errors.push(`kits.${name}.items must list the kit items`);
    else
      kit.items.forEach((it, i) => {
        if (!isObject(it) || (!it.name && !it.nameRegex)) errors.push(`kits.${name}.items[${i}] needs "name" or "nameRegex"`);
        else if (it.nameRegex) regex(`kits.${name}.items[${i}].nameRegex`, it.nameRegex);
        if (!it || !Number.isInteger(it.count) || it.count <= 0) errors.push(`kits.${name}.items[${i}].count must be a positive whole number`);
      });
  }
  if (!s.navigation.autoDetect && !home) errors.push('navigation.home is required when navigation.autoDetect is false');
  return errors;
}

function parseIds(value) {
  return String(value || '')
    .split(/[\s,]+/)
    .filter(Boolean);
}

function loadSecrets(env = process.env) {
  return {
    minecraft: {
      host: env.MINECRAFT_HOST || '',
      port: Number(env.MINECRAFT_PORT || 25565),
      username: env.MINECRAFT_USERNAME || '',
      auth: (env.MINECRAFT_AUTH || 'offline').toLowerCase(),
      password: env.MINECRAFT_PASSWORD || '',
      version: env.MINECRAFT_VERSION || ''
    },
    discord: {
      token: env.DISCORD_TOKEN || '',
      guildId: env.DISCORD_GUILD_ID || '',
      logChannelId: env.DISCORD_LOG_CHANNEL_ID || '',
      deliveriesChannelId: env.DISCORD_DELIVERIES_CHANNEL_ID || '',
      adminIds: parseIds(env.DISCORD_ADMIN_IDS)
    },
    database: {
      url: env.DATABASE_URL || '',
      sqlitePath: env.SQLITE_PATH || path.join(ROOT, 'data', 'kitbot.db')
    }
  };
}

function validateSecrets(secrets, role) {
  const errors = [];
  const snowflake = /^\d{15,22}$/;
  if (role !== 'discord') {
    if (!secrets.minecraft.host) errors.push('MINECRAFT_HOST is required');
    if (!/^[A-Za-z0-9_]{3,16}$/.test(secrets.minecraft.username)) errors.push('MINECRAFT_USERNAME must be a Minecraft username (3-16 letters, digits or _)');
    if (!['offline', 'microsoft'].includes(secrets.minecraft.auth)) errors.push('MINECRAFT_AUTH must be "offline" or "microsoft"');
    if (!Number.isInteger(secrets.minecraft.port) || secrets.minecraft.port <= 0) errors.push('MINECRAFT_PORT must be a port number');
  }
  // Both roles need the token: kit requests are checked against Discord membership.
  if (!secrets.discord.token) errors.push('DISCORD_TOKEN is required');
  for (const k of ['guildId', 'logChannelId', 'deliveriesChannelId']) {
    if (secrets.discord[k] && !snowflake.test(secrets.discord[k])) errors.push(`DISCORD ${k} must be a Discord ID`);
  }
  for (const id of secrets.discord.adminIds) if (!snowflake.test(id)) errors.push(`DISCORD_ADMIN_IDS contains an invalid ID: ${id}`);
  return errors;
}

// Values that must never be printed.
function secretValues(secrets) {
  const values = [secrets.minecraft.password, secrets.discord.token, secrets.database.url];
  try {
    const u = new URL(secrets.database.url);
    if (u.password) values.push(decodeURIComponent(u.password));
  } catch {
    // not a URL
  }
  return values.filter((v) => typeof v === 'string' && v.length >= 3);
}

function loadSettings(env = process.env) {
  const { source, json } = readSettingsJson(env);
  const settings = deepMerge(structuredClone(DEFAULTS), json);
  if (String(env.KITBOT_BOTS_ALLOWED || '').toLowerCase() === 'true') settings.server.botsAllowedConfirmed = true;
  return { settings, source, errors: validateSettings(settings) };
}

function loadConfig({ env = process.env, role = 'all' } = {}) {
  const secrets = loadSecrets(env);
  const { settings, source, errors } = loadSettings(env);
  if (!secrets.minecraft.version) secrets.minecraft.version = settings.server.version;
  const all = [...errors, ...validateSecrets(secrets, role)];
  if (role !== 'discord' && !settings.server.botsAllowedConfirmed) {
    all.push('The server rules must allow bots: tick the box when you start the workflow (or set KITBOT_BOTS_ALLOWED=true)');
  }
  if (all.length) throw Object.assign(new Error(`Invalid configuration:\n - ${all.join('\n - ')}`), { errors: all });
  return { settings, secrets, source, role };
}

function loadDotEnv(file = path.join(ROOT, '.env')) {
  if (fs.existsSync(file) && typeof process.loadEnvFile === 'function') process.loadEnvFile(file);
}

module.exports = { KIT_NAMES, DIRECTIONS, FACINGS, DEFAULTS, deepMerge, validateSettings, loadSettings, loadSecrets, validateSecrets, loadConfig, loadDotEnv, secretValues };
