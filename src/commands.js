'use strict';

// In-game commands, sent in public chat or by whisper:
//   !kit <totem|pvp|grief>   order a kit
//   !kit                     how to use it
//   !link <CODE>             finish linking a Discord account (code from /link)

const { KIT_NAMES } = require('./config');
const limits = require('./limits');
const linking = require('./linking');
const bans = require('./bans');

const KIT_LIST = KIT_NAMES.join(', ');

// message -> { type, ... } or null for ordinary chat.
function parseCommand(message, chat) {
  const parts = String(message || '').trim().split(/\s+/);
  if (parts.join(' ').length > 64) return null;
  const head = parts[0].toLowerCase();
  if (head === chat.kitCommand.toLowerCase()) {
    if (parts.length === 1) return { type: 'kit_usage' };
    const kit = parts[1].toLowerCase();
    return KIT_NAMES.includes(kit) ? { type: 'kit', kit } : { type: 'kit_unknown' };
  }
  if (head === chat.linkCommand.toLowerCase()) return parts.length === 2 ? { type: 'link', code: parts[1] } : { type: 'link_usage' };
  return null;
}

const LINK_ERRORS = {
  invalid_username: 'That Minecraft name is not valid.',
  invalid_code: 'That link code is wrong or was made for another Minecraft name.',
  expired_code: 'That link code has expired. Run /link again in Discord.',
  too_many_attempts: 'Too many wrong codes. Try again in an hour.',
  discord_unavailable: 'Discord cannot be reached right now. Try again in a few minutes.',
  not_member: 'You must be in our Discord server to link your account.',
  missing_role: 'Your Discord account does not have the role needed for the kit bot.',
  taken: 'This Minecraft account is already linked to another Discord account.',
  already_linked: 'This Minecraft account is already linked to your Discord account.',
  limit_reached: 'Your Discord account cannot link more Minecraft accounts.',
  link_changed: 'Your link changed while this code was waiting. Run /link again in Discord.'
};

// handle(username, message, player) -> result | null
//   player: { username, uuid } from the tab list
function createCommandHandler({ db, getSettings, getRuntime, logger, checkMembership, reply, onQueued = () => {}, now = () => Date.now() }) {
  const lastCommand = new Map();

  function tooFast(name, s) {
    const key = name.toLowerCase();
    const t = now();
    const last = lastCommand.get(key) || 0;
    lastCommand.set(key, t);
    if (lastCommand.size > 2000) for (const [k, v] of lastCommand) if (t - v > 60000) lastCommand.delete(k);
    return t - last < s.chat.perPlayerCommandIntervalMs;
  }

  async function refuse(name, kit, reason, message, level = 'info') {
    await logger[level]('request.refused', `Refused ${kit} kit for ${name}: ${reason}.`);
    await reply(name, message);
    return { accepted: false, reason };
  }

  async function orderKit(name, kit, player, s) {
    const rt = getRuntime();
    if (rt.maintenance) return refuse(name, kit, 'maintenance', 'The kit bot is under maintenance. Try again later.');
    if (rt.paused) return refuse(name, kit, 'paused', 'Kit deliveries are paused right now. Try again later.');
    if (!rt.ready) return refuse(name, kit, 'bot not ready', 'The kit bot is still starting. Try again in a minute.');

    const link = await linking.activeLinkByUsername(db, name);
    if (await bans.findBan(db, { name, discordId: link?.discord_id })) return refuse(name, kit, 'banned', 'You are banned from the kit bot.', 'warn');
    if (!link) return refuse(name, kit, 'not linked', 'Link your account first: run /link in our Discord, then whisper me "!link <code>".');
    if (link.mc_uuid && player.uuid && link.mc_uuid !== player.uuid) return refuse(name, kit, 'UUID does not match the linked account', 'This account does not match the linked one. Contact staff.', 'warn');

    const m = await checkMembership(link.discord_id);
    if (m.status === 'unavailable') return refuse(name, kit, 'Discord unreachable', 'Discord cannot be reached right now. Try again in a few minutes.', 'warn');
    if (m.status === 'not_member') {
      const revoked = await linking.revokeLinks(db, link.discord_id, 'left the Discord server');
      if (revoked.length) await logger.warn('link.revoked', `Unlinked ${name} from <@${link.discord_id}>: no longer in the Discord server.`);
      return refuse(name, kit, 'left the Discord server', 'You are no longer in our Discord server. Join again and re-link your account.');
    }
    if (m.status !== 'member') return refuse(name, kit, m.status, LINK_ERRORS.missing_role);
    if (!rt.stationReady) return refuse(name, kit, 'kit chests not found', 'The kit bot is not set up yet. Try again later.', 'warn');

    const r = await limits.reserve(db, { discordId: link.discord_id, name, kit, limits: s.limits, now: now() });
    if (!r.ok) {
      const wait = r.retryAt ? limits.formatDuration(r.retryAt - now()) : '';
      const messages = {
        pending: 'You already have a kit on the way.',
        cooldown: `Please wait ${wait} before ordering another kit.`,
        quota: `You reached your limit of ${s.limits.dailyQuota} kits per ${s.limits.quotaWindowHours}h. Next kit in ${wait}.`,
        queue_full: 'The queue is full. Try again in a few minutes.'
      };
      return refuse(name, kit, r.reason, messages[r.reason] || 'Your order could not be accepted.');
    }
    await logger.info('request.accepted', `${name} (<@${link.discord_id}>) ordered a ${kit} kit: request #${r.request.id}, position ${r.position} in the queue.`);
    await reply(name, `Order received: ${kit} kit, position ${r.position} in the queue.`);
    onQueued(r.request);
    return { accepted: true, request: r.request, position: r.position };
  }

  async function finishLink(name, code, player, s) {
    if (await bans.findBan(db, { name })) {
      await logger.warn('link.refused', `Link by ${name} refused: banned.`);
      await reply(name, 'You are banned from the kit bot.');
      return { ok: false, reason: 'banned' };
    }
    const res = await linking.completeLink(db, { name, uuid: player.uuid, code, settings: s, checkMembership, now: now() });
    if (!res.ok) {
      const msg = res.reason === 'change_too_soon' ? `You can change your linked account once every ${s.linking.usernameChangeCooldownDays} days.` : LINK_ERRORS[res.reason] || 'Linking failed.';
      await logger.warn('link.failed', `Link by ${name} failed: ${res.reason}.`);
      await reply(name, msg);
      return res;
    }
    await logger.info('link.done', res.mode === 'change' ? `<@${res.discordId}> changed their linked account from ${res.previous} to ${name}.` : `Linked ${name} to <@${res.discordId}>.`);
    await reply(name, `Linked to your Discord account! Order with ${s.chat.kitCommand} <${KIT_NAMES.join('|')}>.`);
    return res;
  }

  return async function handle(username, message, player) {
    const s = getSettings();
    const cmd = parseCommand(message, s.chat);
    if (!cmd) return null;
    const name = player?.username || username;
    await logger.info('chat.command', `${name}: ${String(message).slice(0, 64)}`);
    if (tooFast(name, s)) {
      await logger.debug('chat.command', `Ignored ${name}: commands sent too quickly.`);
      return null;
    }
    switch (cmd.type) {
      case 'kit_usage':
        await reply(name, `Usage: ${s.chat.kitCommand} <kit>. Kits: ${KIT_LIST}.`);
        return { accepted: false, reason: 'usage' };
      case 'kit_unknown':
        await reply(name, `Unknown kit. Kits: ${KIT_LIST}.`);
        return { accepted: false, reason: 'unknown_kit' };
      case 'kit':
        return orderKit(name, cmd.kit, player || { username: name }, s);
      case 'link_usage':
        await reply(name, `Usage: ${s.chat.linkCommand} <code>. Get a code with /link in our Discord server.`);
        return { ok: false, reason: 'usage' };
      case 'link':
        return finishLink(name, cmd.code, player || { username: name }, s);
      default:
        return null;
    }
  };
}

module.exports = { parseCommand, createCommandHandler, LINK_ERRORS };
