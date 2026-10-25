'use strict';

// In-game command handling, independent of Mineflayer so it can be tested.
//   !kit <name>   request a kit (totem, pvp, grief; case-insensitive)
//   !link <CODE>  finish linking a Discord account (code from /link in Discord)

const { KIT_NAMES } = require('./config');
const limits = require('./limits');
const linking = require('./linking');
const bans = require('./bans');

function compilePatterns(patterns) {
  return patterns.map((p) => new RegExp(p));
}

// Extracts { username, message } from a chat line using the configured,
// anchored patterns. Returns null for anything else (system messages, etc).
function parseChatLine(line, compiled) {
  if (typeof line !== 'string' || line.length > 512) return null;
  for (const re of compiled) {
    const m = re.exec(line);
    if (m && m.groups && m.groups.username && m.groups.message !== undefined) {
      if (!/^[A-Za-z0-9_]{1,16}$/.test(m.groups.username)) continue;
      return { username: m.groups.username, message: m.groups.message.trim() };
    }
  }
  return null;
}

// For signed player chat the server tells us who sent the message (UUID), so
// only the message text has to be found: it follows the sender's name and a
// separator such as ">", ":" or "»", whatever the chat format.
function parseSignedChat(line, username) {
  if (typeof line !== 'string' || line.length > 512) return null;
  const idx = line.indexOf(username);
  if (idx < 0) return null;
  const rest = line.slice(idx + username.length);
  const m = /^\s*(?:>|:|»|>>|\]|\)|-|\|)+\s*(.+)$/.exec(rest);
  if (!m) return null;
  return { username, message: m[1].trim() };
}

// Returns null when the message is not a bot command (normal chat is ignored).
// ask: settings.ask (optional) - "!ask <question>" keeps the question text.
function parseCommand(message, chat, ask = null) {
  if (typeof message !== 'string') return null;
  const text = message.trim();
  if (ask && ask.command) {
    const cmd = ask.command.toLowerCase();
    const lower = text.toLowerCase();
    if (lower === cmd || lower.startsWith(`${cmd} `)) return { type: 'ask', question: text.slice(cmd.length).trim() };
  }
  if (text.length > 64) return null;
  const parts = text.split(/\s+/);
  const head = parts[0].toLowerCase();
  if (head === chat.kitCommand.toLowerCase()) {
    if (parts.length !== 2) return { type: 'kit_usage' };
    const kit = parts[1].toLowerCase();
    if (!/^[a-z]{1,16}$/.test(kit) || !KIT_NAMES.includes(kit)) return { type: 'kit_unknown' };
    return { type: 'kit', kit };
  }
  if (head === chat.linkCommand.toLowerCase()) {
    if (parts.length !== 2) return { type: 'link_usage' };
    return { type: 'link', code: parts[1] };
  }
  return null;
}

const KIT_LIST = KIT_NAMES.join(', ');

const LINK_ERRORS = {
  invalid_username: 'That Minecraft username is not valid.',
  invalid_code: 'That link code is invalid or was not issued for this account.',
  expired_code: 'That link code has expired. Run /link again in Discord.',
  too_many_attempts: 'Too many failed link attempts. Try again later.',
  discord_unavailable: 'Discord verification is temporarily unavailable. Try again in a few minutes.',
  not_member: 'You must be a member of our Discord server to link your account.',
  missing_role: 'Your Discord account is missing the role required to use the kit bot.',
  taken: 'This Minecraft account is already linked to another Discord account.',
  already_linked: 'This Minecraft account is already linked to your Discord account.',
  limit_reached: 'Your Discord account has reached its linked-account limit.',
  change_too_soon: 'You can only change your linked Minecraft account once every 30 days.',
  link_changed: 'Your link changed while this code was pending. Run /link again in Discord.'
};

// ask(question, player) -> { ok, answer } | { ok: false, reason } (null when no
// AI key is configured); sayPublic(text) writes in the public chat.
function createRequestHandler({ db, getSettings, getRuntime, logger, checkMembership, getOnlinePlayer, reply, ask = null, sayPublic = async () => {}, onQueued = () => {}, now = () => Date.now() }) {
  const lastAskAt = new Map();
  // Questions are answered one after another, in order (the free AI takes one at a time).
  let askChain = Promise.resolve();
  let askWaiting = 0;
  const lastCommandAt = new Map();
  const recent = new Map();

  function isDuplicateOrSpam(username, message, s) {
    const t = now();
    const key = `${username.toLowerCase()}|${message.toLowerCase()}`;
    if (recent.has(key) && t - recent.get(key) < s.chat.duplicateWindowMs) return true;
    recent.set(key, t);
    const last = lastCommandAt.get(username.toLowerCase());
    lastCommandAt.set(username.toLowerCase(), t);
    if (last && t - last < s.chat.perPlayerCommandIntervalMs) return true;
    if (recent.size > 5000) {
      for (const [k, v] of recent) if (t - v > 60000) recent.delete(k);
      for (const [k, v] of lastCommandAt) if (t - v > 60000) lastCommandAt.delete(k);
    }
    return false;
  }

  async function reject(username, kit, reason, message, level = 'info') {
    await logger[level]('request.rejected', `Rejected ${kit || 'kit'} request from ${username}: ${reason}`);
    await reply(username, message);
    return { accepted: false, reason };
  }

  async function handleKit(username, kit, player, s) {
    const runtime = getRuntime();
    if (runtime.maintenance) return reject(username, kit, 'maintenance', 'The kit bot is under maintenance. Please try again later.');
    if (runtime.paused) return reject(username, kit, 'paused', 'Kit deliveries are paused right now. Please try again later.');
    if (!runtime.minecraftReady) return reject(username, kit, 'not_ready', 'The kit bot is not ready yet. Please try again in a moment.');
    if (runtime.stationReady === false) return reject(username, kit, 'not_set_up', 'The kit bot is not set up yet. Please try again later.', 'warn');

    const link = await linking.getActiveLinkByUsername(db, username);
    if (await bans.findBan(db, { mcUsername: username, discordId: link ? link.discord_id : null })) {
      return reject(username, kit, 'banned', 'You are banned from the kit bot.', 'warn');
    }
    if (!link) {
      return reject(username, kit, 'not_linked', 'You must join our Discord and link your account first: run /link in Discord, then whisper me "!link <code>".');
    }
    if (link.mc_uuid && player && player.uuid && link.mc_uuid !== player.uuid) {
      return reject(username, kit, 'uuid_mismatch', 'This account does not match the linked account. Contact staff.', 'warn');
    }

    const membership = await checkMembership(link.discord_id);
    if (membership.status === 'unavailable') {
      return reject(username, kit, 'discord_unavailable', 'Discord verification is temporarily unavailable. Please try again in a few minutes.', 'warn');
    }
    if (membership.status !== 'member') {
      if (membership.status === 'not_member') {
        const revoked = await linking.revokeLinks(db, link.discord_id, 'left the Discord server');
        if (revoked.length) await logger.warn('link.revoked', `Revoked link ${username} <-> <@${link.discord_id}>: no longer a member of the Discord server.`);
        return reject(username, kit, 'not_member', 'You are no longer in our Discord server. Rejoin and link your account again to request kits.');
      }
      return reject(username, kit, membership.status, LINK_ERRORS.missing_role);
    }

    const r = await limits.reserve(db, { discordId: link.discord_id, mcUsername: username, kit, limits: s.limits, now: now() });
    if (!r.ok) {
      switch (r.reason) {
        case 'pending':
          return reject(username, kit, 'pending', 'You already have a kit request in progress.');
        case 'cooldown':
          await logger.warn('limit.cooldown', `${username} hit the cooldown (${limits.formatDuration(r.retryAt - now())} left).`);
          await reply(username, `You must wait before requesting another kit (${limits.formatDuration(r.retryAt - now())} left).`);
          return { accepted: false, reason: 'cooldown' };
        case 'quota':
          await logger.warn('limit.quota', `${username} reached the quota of ${s.limits.dailyQuota} kits per ${s.limits.quotaWindowHours}h.`);
          await reply(username, `You have reached your daily limit of ${s.limits.dailyQuota} kits. Next kit available in ${limits.formatDuration(r.retryAt - now())}.`);
          return { accepted: false, reason: 'quota' };
        case 'queue_full':
          return reject(username, kit, 'queue_full', 'The delivery queue is full. Please try again in a few minutes.', 'warn');
        default:
          return reject(username, kit, r.reason, 'Your request could not be accepted.');
      }
    }
    await logger.info('request.accepted', `Accepted ${kit} kit request #${r.request.id} from ${username} (<@${link.discord_id}>).`);
    await logger.info('queue.added', `Request #${r.request.id} queued at position ${r.position}.`);
    await reply(username, `Your request has been queued for delivery (position ${r.position}).`);
    onQueued(r.request);
    return { accepted: true, request: r.request, position: r.position };
  }

  async function handleLink(username, code, player, s) {
    if (await bans.findBan(db, { mcUsername: username })) {
      await logger.warn('link.failed', `Link attempt by ${username} refused: banned`);
      await reply(username, 'You are banned from the kit bot.');
      return { ok: false, reason: 'banned' };
    }
    const res = await linking.completeLink(db, {
      mcUsername: username,
      mcUuid: player?.uuid || null,
      code,
      settings: s,
      checkMembership,
      now: now()
    });
    if (!res.ok) {
      const msg = res.reason === 'change_too_soon' ? `You can only change your linked Minecraft account once every ${s.linking.usernameChangeCooldownDays} days.` : LINK_ERRORS[res.reason] || 'Linking failed.';
      await logger.warn('link.failed', `Link attempt by ${username} failed: ${res.reason}`);
      await reply(username, msg);
      return res;
    }
    if (res.mode === 'change') {
      await logger.info('link.username_changed', `<@${res.discordId}> changed linked account ${res.previous} -> ${username}.`);
    } else {
      await logger.info('link.created', `Linked ${username} to <@${res.discordId}>.`);
    }
    await reply(username, 'Your Minecraft account is now linked to your Discord account. You can use !kit <totem|pvp|grief>.');
    return res;
  }

  async function handleAsk(username, question, s) {
    const cfg = s.ask;
    const wait = (ms) => `${Math.ceil(ms / 1000)}s`;
    if (!ask) {
      await reply(username, `${cfg.command} is not available right now.`);
      return { ok: false, reason: 'disabled' };
    }
    if (!question) {
      await reply(username, `Usage: ${cfg.command} <your question>`);
      return { ok: false, reason: 'usage' };
    }
    if (question.length > cfg.maxQuestionLength) {
      await reply(username, `Your question is too long (${cfg.maxQuestionLength} characters max).`);
      return { ok: false, reason: 'too_long' };
    }
    const link = await linking.getActiveLinkByUsername(db, username);
    if (await bans.findBan(db, { mcUsername: username, discordId: link ? link.discord_id : null })) {
      await reply(username, 'You are banned from the kit bot.');
      return { ok: false, reason: 'banned' };
    }
    if (cfg.requireLink && !link) {
      await reply(username, `Link your account first to use ${cfg.command}: run /link in our Discord.`);
      return { ok: false, reason: 'not_linked' };
    }
    const t = now();
    const mine = lastAskAt.get(username.toLowerCase()) || 0;
    if (cfg.cooldownSeconds > 0 && t - mine < cfg.cooldownSeconds * 1000) {
      await reply(username, `Wait ${wait(cfg.cooldownSeconds * 1000 - (t - mine))} before asking again.`);
      return { ok: false, reason: 'cooldown' };
    }
    if (askWaiting >= cfg.maxQueued) {
      await reply(username, 'Too many questions are waiting, try again in a minute.');
      return { ok: false, reason: 'queue_full' };
    }
    lastAskAt.set(username.toLowerCase(), t);
    askWaiting++;
    const run = askChain.then(async () => {
      try {
        const r = await ask(question, username);
        if (!r.ok) {
          const why = { refused: "Sorry, I can't answer that.", empty: "Sorry, I can't answer that.", busy: 'The AI is busy, try again in a minute.' };
          await reply(username, why[r.reason] || 'The AI did not answer, try again later.');
          return r;
        }
        await sayPublic(cfg.replyFormat.replace(/\{player\}/g, username).replace(/\{answer\}/g, r.answer));
        await logger.info('ask.answered', `${username} asked "${question}" -> "${r.answer}"`);
        return r;
      } finally {
        askWaiting--;
      }
    });
    askChain = run.catch(() => {});
    return run;
  }

  return async function handle(username, message) {
    const s = getSettings();
    const cmd = parseCommand(message, s.chat, s.ask);
    if (!cmd) return null; // normal chat: ignore
    if (!/^[A-Za-z0-9_]{1,16}$/.test(username)) return null;
    const player = getOnlinePlayer(username);
    if (s.chat.requireOnlinePlayer && !player) return null; // not a real online player: possible spoof
    if (isDuplicateOrSpam(username, message, s)) return null;

    switch (cmd.type) {
      case 'kit_usage':
        await reply(username, `Usage: ${s.chat.kitCommand} <kit>. Available kits: ${KIT_LIST}.`);
        return { accepted: false, reason: 'usage' };
      case 'kit_unknown':
        await logger.info('request.rejected', `Rejected request from ${username}: unknown kit`);
        await reply(username, `Unknown kit. Available kits: ${KIT_LIST}.`);
        return { accepted: false, reason: 'unknown_kit' };
      case 'kit':
        return handleKit(username, cmd.kit, player, s);
      case 'link_usage':
        await reply(username, `Usage: ${s.chat.linkCommand} <code>. Get a code with /link in our Discord server.`);
        return { ok: false, reason: 'usage' };
      case 'link':
        return handleLink(username, cmd.code, player, s);
      case 'ask':
        return handleAsk(username, cmd.question, s);
      default:
        return null;
    }
  };
}

module.exports = { compilePatterns, parseChatLine, parseSignedChat, parseCommand, createRequestHandler, LINK_ERRORS };
