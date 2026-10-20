'use strict';

// Configuration loading and validation.
// Secrets come ONLY from environment variables (GitHub Secrets / .env).
// Non-secret settings (kit locations, limits, chat patterns) come from a JSON
// file (config.json) or from the KITBOT_CONFIG_JSON environment variable, so
// that stash coordinates never have to be committed to a public repository.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const KIT_NAMES = ['totem', 'pvp', 'grief'];
const DIRECTIONS = ['left', 'right', 'backward', 'forward'];
const FACINGS = { south: 0, west: 90, north: 180, east: -90 };
const DELIVERY_METHODS = ['drop', 'teleport'];
const RETRIEVAL_METHODS = ['chest', 'command'];

const DEFAULTS = {
  server: {
    botsAllowedConfirmed: false,
    rulesUrl: '',
    version: '1.21.11',
    stopOnKickPattern: '(banned|blacklisted|bots? (are )?not allowed)'
  },
  auth: {
    enabled: true,
    registerCommand: '/reg {password} {password}',
    loginCommand: '/log {password}',
    registerPromptPattern: '/reg(ister)?\\b',
    loginPromptPattern: '/l(og|ogin)\\b',
    successPattern: '(success|logged in)',
    alreadyRegisteredPattern: 'already (been )?registered',
    notRegisteredPattern: "(isn't|is not|not) registered",
    failurePattern: '(wrong password|incorrect password|invalid password)',
    promptTimeoutMs: 10000,
    successTimeoutMs: 15000,
    postLoginCommands: [],
    postLoginDelayMs: 3000
  },
  chat: {
    kitCommand: '!kit',
    linkCommand: '!link',
    replyCommand: '/msg {player} {message}',
    minDelayMs: 1500,
    maxLength: 240,
    perPlayerCommandIntervalMs: 3000,
    duplicateWindowMs: 5000,
    requireOnlinePlayer: true,
    patterns: [
      '^<(?<username>[A-Za-z0-9_]{1,16})> (?<message>.+)$',
      '^(?<username>[A-Za-z0-9_]{1,16}) whispers(?: to you)?: (?<message>.+)$',
      '^\\[(?<username>[A-Za-z0-9_]{1,16}) -> (?:me|you)\\] (?<message>.+)$',
      '^From (?<username>[A-Za-z0-9_]{1,16}): (?<message>.+)$',
      '^(?<username>[A-Za-z0-9_]{1,16}) -> (?:me|you): (?<message>.+)$',
      // Plugin chat formats such as "[VIP] Name: msg" or "Name » msg" (keep last).
      '^(?:\\[[^\\]]{1,32}\\] ?)*(?<username>[A-Za-z0-9_]{1,16}) ?(?:»|>>|:) (?<message>.+)$'
    ]
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
    // With autoDetect, an unset home is read from where the bot stands, and
    // the kit chests are found to its left, right and behind (src/station.js).
    autoDetect: true,
    scanDistance: 6,
    home: null,
    returnHomeAfterDelivery: true,
    allowDigging: false,
    allowPlacing: false,
    allowParkour: false,
    allowSprinting: true,
    arriveRadius: 1,
    defaultTimeoutMs: 60000,
    // Too far to walk home (e.g. after teleporting to a player): run these
    // commands, e.g. "/kill" to respawn at the bed next to the base.
    farFromHomeBlocks: 32,
    returnCommands: ['/kill'],
    respawnWaitMs: 20000
  },
  // Default: the bot sends /tpa to the player, who accepts with /tpaccept.
  // "drop" instead: the bot waits at delivery.dropoff (default: home).
  delivery: {
    method: 'teleport',
    dropoff: null,
    commands: ['/tpa {player}'],
    acceptRequest: null,
    afterCommands: [],
    instructions: 'Your {kit} kit is ready! Accept my teleport request (/tpaccept) within 60 seconds to receive it.',
    playerRadius: 4,
    waitForPlayerMs: 60000,
    pickupTimeoutMs: 15000,
    returnUndelivered: true
  },
  kits: {
    totem: { direction: 'left', distance: null, standAt: null, retrieval: { method: 'chest', container: null, items: [{ nameRegex: 'shulker_box$', count: 1 }] } },
    pvp: { direction: 'right', distance: null, standAt: null, retrieval: { method: 'chest', container: null, items: [{ nameRegex: 'shulker_box$', count: 1 }] } },
    grief: { direction: 'backward', distance: null, standAt: null, retrieval: { method: 'chest', container: null, items: [{ nameRegex: 'shulker_box$', count: 1 }] } }
  },
  logging: {
    retentionDays: 30,
    consoleLevel: 'INFO'
  }
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

function readSettingsSource(env) {
  if (env.KITBOT_CONFIG_JSON && env.KITBOT_CONFIG_JSON.trim()) {
    let raw = env.KITBOT_CONFIG_JSON.trim();
    // Accept either raw JSON or base64-encoded JSON (easier to paste as a secret).
    if (!raw.startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8');
    return { source: 'KITBOT_CONFIG_JSON', json: JSON.parse(raw) };
  }
  const file = path.resolve(ROOT, env.KITBOT_CONFIG || 'config.json');
  if (!fs.existsSync(file)) {
    // An explicitly named file must exist; otherwise run on the built-in defaults.
    if (env.KITBOT_CONFIG) throw new Error(`Configuration file not found: ${file}`);
    return { source: 'built-in defaults', json: {} };
  }
  return { source: file, json: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

function parseIdList(value) {
  return String(value || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function loadSecrets(env) {
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
      adminIds: parseIdList(env.DISCORD_ADMIN_IDS)
    },
    database: {
      url: env.DATABASE_URL || '',
      sqlitePath: env.SQLITE_PATH || path.join(ROOT, 'data', 'kitbot.db')
    }
  };
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isPos = (v) => isPlainObject(v) && isNum(v.x) && isNum(v.y) && isNum(v.z);

function checkRegex(errors, where, pattern) {
  try {
    new RegExp(pattern, 'i');
  } catch (e) {
    errors.push(`${where}: invalid regular expression (${e.message})`);
  }
}

// Validates the merged settings. With allowPlaceholders, unset (null)
// coordinates are accepted so config.example.json can be checked in CI.
function validateSettings(s, { allowPlaceholders = false } = {}) {
  const errors = [];
  // Coordinates left unset are filled in at runtime by station auto-detection.
  if (s.navigation.autoDetect && s.navigation.home === null) allowPlaceholders = true;
  const needPos = (where, v) => {
    const placeholder = v === null || v === undefined || (isPlainObject(v) && v.x === null && v.y === null && v.z === null);
    if (placeholder) {
      if (!allowPlaceholders) errors.push(`${where}: coordinates must be set ({"x":..,"y":..,"z":..})`);
    } else if (!isPos(v)) {
      errors.push(`${where}: must be an object with numeric x, y and z`);
    }
  };
  const positive = (where, v) => {
    if (!isNum(v) || v <= 0) errors.push(`${where}: must be a positive number`);
  };

  positive('limits.cooldownMinutes', s.limits.cooldownMinutes);
  positive('limits.dailyQuota', s.limits.dailyQuota);
  positive('limits.quotaWindowHours', s.limits.quotaWindowHours);
  positive('limits.globalPerMinute', s.limits.globalPerMinute);
  positive('limits.maxQueueSize', s.limits.maxQueueSize);
  positive('limits.maxQueueWaitMinutes', s.limits.maxQueueWaitMinutes);
  positive('limits.maxAttempts', s.limits.maxAttempts);
  positive('linking.maxLinksPerDiscord', s.linking.maxLinksPerDiscord);
  positive('linking.codeTtlMinutes', s.linking.codeTtlMinutes);
  positive('linking.usernameChangeCooldownDays', s.linking.usernameChangeCooldownDays);
  positive('chat.maxLength', s.chat.maxLength);

  if (!/^![a-z]+$/i.test(s.chat.kitCommand)) errors.push('chat.kitCommand: must look like "!kit"');
  if (!/^![a-z]+$/i.test(s.chat.linkCommand)) errors.push('chat.linkCommand: must look like "!link"');
  if (!s.chat.replyCommand.includes('{player}') || !s.chat.replyCommand.includes('{message}')) {
    errors.push('chat.replyCommand: must contain {player} and {message}');
  }
  if (!Array.isArray(s.chat.patterns) || s.chat.patterns.length === 0) {
    errors.push('chat.patterns: at least one pattern is required');
  } else {
    s.chat.patterns.forEach((p, i) => {
      checkRegex(errors, `chat.patterns[${i}]`, p);
      if (!p.includes('(?<username>') || !p.includes('(?<message>')) {
        errors.push(`chat.patterns[${i}]: must contain named groups (?<username>...) and (?<message>...)`);
      }
      if (!p.startsWith('^')) errors.push(`chat.patterns[${i}]: must be anchored with ^ to prevent spoofing`);
    });
  }
  for (const key of ['registerPromptPattern', 'loginPromptPattern', 'successPattern', 'alreadyRegisteredPattern', 'notRegisteredPattern', 'failurePattern']) {
    checkRegex(errors, `auth.${key}`, s.auth[key]);
  }

  const home = s.navigation.home;
  if (home !== null) {
    needPos('navigation.home', home);
    if (home && home.facing !== undefined && !(home.facing in FACINGS)) {
      errors.push(`navigation.home.facing: must be one of ${Object.keys(FACINGS).join(', ')}`);
    }
    if (home && home.yawDegrees !== undefined && !isNum(home.yawDegrees)) {
      errors.push('navigation.home.yawDegrees: must be a number (F3 "Facing" yaw)');
    }
  }

  for (const name of KIT_NAMES) {
    const kit = s.kits[name];
    const w = `kits.${name}`;
    if (!isPlainObject(kit)) {
      errors.push(`${w}: missing kit definition`);
      continue;
    }
    if (!DIRECTIONS.includes(kit.direction)) errors.push(`${w}.direction: must be one of ${DIRECTIONS.join(', ')}`);
    if (kit.standAt === null || kit.standAt === undefined) {
      if (!isNum(kit.distance) || kit.distance <= 0) {
        if (!allowPlaceholders) errors.push(`${w}: set either "standAt" coordinates or a positive "distance" from navigation.home`);
      } else if (home === null && !allowPlaceholders) {
        errors.push(`${w}: "distance" requires navigation.home to be set`);
      }
    } else {
      needPos(`${w}.standAt`, kit.standAt);
    }
    if (kit.timeoutMs !== undefined) positive(`${w}.timeoutMs`, kit.timeoutMs);

    const r = kit.retrieval;
    if (!isPlainObject(r) || !RETRIEVAL_METHODS.includes(r.method)) {
      errors.push(`${w}.retrieval.method: must be one of ${RETRIEVAL_METHODS.join(', ')}`);
    } else {
      if (!Array.isArray(r.items) || r.items.length === 0) {
        errors.push(`${w}.retrieval.items: list the items that make up the kit`);
      } else {
        r.items.forEach((it, i) => {
          if (!isPlainObject(it) || (!it.name && !it.nameRegex)) errors.push(`${w}.retrieval.items[${i}]: needs "name" or "nameRegex"`);
          if (it && it.nameRegex) checkRegex(errors, `${w}.retrieval.items[${i}].nameRegex`, it.nameRegex);
          if (!it || !Number.isInteger(it.count) || it.count <= 0) errors.push(`${w}.retrieval.items[${i}].count: must be a positive integer`);
        });
      }
      if (r.method === 'chest') needPos(`${w}.retrieval.container`, r.container);
      if (r.method === 'command') {
        if (!Array.isArray(r.commands) || r.commands.length === 0) errors.push(`${w}.retrieval.commands: required for the "command" method`);
      }
    }

    const d = resolveDelivery(s, name);
    if (!DELIVERY_METHODS.includes(d.method)) errors.push(`${w}.delivery.method: must be one of ${DELIVERY_METHODS.join(', ')}`);
    if (d.method === 'drop' && d.dropoff !== null) needPos(`${w}.delivery.dropoff`, d.dropoff);
    if (d.method === 'teleport' && (!Array.isArray(d.commands) || d.commands.length === 0) && !d.acceptRequest) {
      errors.push(`${w}.delivery: the "teleport" method needs "commands" (e.g. ["/tpa {player}"]) or "acceptRequest"`);
    }
    if (d.acceptRequest) {
      if (!d.acceptRequest.pattern || !d.acceptRequest.command) errors.push(`${w}.delivery.acceptRequest: needs "pattern" and "command"`);
      else checkRegex(errors, `${w}.delivery.acceptRequest.pattern`, d.acceptRequest.pattern);
    }
  }
  for (const name of Object.keys(s.kits)) {
    if (!KIT_NAMES.includes(name)) errors.push(`kits.${name}: unknown kit (allowed: ${KIT_NAMES.join(', ')})`);
  }
  return errors;
}

// A missing drop-off point defaults to the bot's home spot.
function resolveDelivery(settings, kitName) {
  const kit = settings.kits[kitName] || {};
  const d = deepMerge(settings.delivery, kit.delivery || {});
  if (!d.dropoff && settings.navigation.home) d.dropoff = { x: settings.navigation.home.x, y: settings.navigation.home.y, z: settings.navigation.home.z };
  return d;
}

function validateSecrets(secrets, role) {
  const errors = [];
  const needsMc = role === 'all' || role === 'minecraft';
  const needsDiscord = true; // membership checks in the Minecraft role also need the Discord token
  if (needsMc) {
    if (!secrets.minecraft.host) errors.push('MINECRAFT_HOST is required');
    if (!secrets.minecraft.username) errors.push('MINECRAFT_USERNAME is required');
    if (!['offline', 'microsoft'].includes(secrets.minecraft.auth)) errors.push('MINECRAFT_AUTH must be "offline" or "microsoft"');
    if (!Number.isInteger(secrets.minecraft.port) || secrets.minecraft.port <= 0) errors.push('MINECRAFT_PORT must be a port number');
  }
  // Server, log channel and admins are optional: src/discord-setup.js finds
  // the server, creates #kitbot-logs and uses the server owner as admin.
  if (needsDiscord) {
    if (!secrets.discord.token) errors.push('DISCORD_TOKEN is required');
    if (secrets.discord.guildId && !/^\d{15,22}$/.test(secrets.discord.guildId)) errors.push('DISCORD_GUILD_ID must be a Discord server ID');
  }
  if (secrets.discord.logChannelId && !/^\d{15,22}$/.test(secrets.discord.logChannelId)) errors.push('DISCORD_LOG_CHANNEL_ID must be a channel ID');
  for (const id of secrets.discord.adminIds) if (!/^\d{15,22}$/.test(id)) errors.push(`DISCORD_ADMIN_IDS contains an invalid ID: ${id}`);
  return errors;
}

// Values that must never appear in logs or Discord messages.
function secretValues(secrets) {
  const vals = [secrets.minecraft.password, secrets.discord.token, secrets.database.url];
  try {
    if (secrets.database.url) {
      const u = new URL(secrets.database.url);
      if (u.password) vals.push(decodeURIComponent(u.password));
    }
  } catch {
    // not a URL; the full value is already redacted
  }
  return vals.filter((v) => typeof v === 'string' && v.length >= 3);
}

function loadSettings(env = process.env, opts = {}) {
  const { source, json } = readSettingsSource(env);
  const settings = deepMerge(DEFAULTS, json);
  // Set by the "Run KitBot" workflow checkbox confirming the server rules.
  if (String(env.KITBOT_BOTS_ALLOWED || '').toLowerCase() === 'true') settings.server.botsAllowedConfirmed = true;
  const errors = validateSettings(settings, opts);
  return { settings, errors, source };
}

function loadConfig({ env = process.env, role = 'all', allowPlaceholders = false } = {}) {
  const secrets = loadSecrets(env);
  const { settings, errors, source } = loadSettings(env, { allowPlaceholders });
  if (!secrets.minecraft.version) secrets.minecraft.version = settings.server.version;
  const all = [...errors, ...validateSecrets(secrets, role)];
  if ((role === 'all' || role === 'minecraft') && settings.server.botsAllowedConfirmed !== true && !allowPlaceholders) {
    all.push('server.botsAllowedConfirmed must be true: read the server rules and confirm automated bots are allowed before enabling the Minecraft bot');
  }
  if (all.length) {
    const err = new Error(`Invalid configuration:\n - ${all.join('\n - ')}`);
    err.errors = all;
    throw err;
  }
  return { settings, secrets, source, role };
}

// Loads .env when present (local development). GitHub Actions passes real env vars.
function loadDotEnv(file = path.join(ROOT, '.env')) {
  if (fs.existsSync(file) && typeof process.loadEnvFile === 'function') process.loadEnvFile(file);
}

module.exports = {
  KIT_NAMES,
  DIRECTIONS,
  FACINGS,
  DEFAULTS,
  deepMerge,
  loadConfig,
  loadSettings,
  loadSecrets,
  loadDotEnv,
  validateSettings,
  validateSecrets,
  resolveDelivery,
  secretValues,
  parseIdList
};
