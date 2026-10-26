'use strict';

// Administrator actions behind /kitbot, free of discord.js objects so they
// can be tested. The Minecraft bot picks up pause, maintenance, reload,
// recalibrate and say from the database within 3 seconds.

const crypto = require('node:crypto');
const { getSetting, setSetting, getStatuses } = require('../db');
const { loadSettings } = require('../config');
const linking = require('../linking');
const limits = require('../limits');
const bans = require('../bans');
const { queueSnapshot, globalStats, playerStats } = require('../queue');
const { recentEvents } = require('../log');
const { readStock } = require('../stock');

// Asked to confirm with a button first.
const SENSITIVE = new Set(['unlink', 'cooldown-reset', 'quota-reset', 'maintenance']);

const HELP = [
  ['/kitbot status', 'Bot status, queue and recent errors'],
  ['/kitbot stats', 'Request and delivery statistics'],
  ['/kitbot player <player>', 'A player link, limits and history'],
  ['/kitbot queue', 'Waiting orders'],
  ['/kitbot pause', 'Pause deliveries'],
  ['/kitbot resume', 'Resume deliveries'],
  ['/kitbot maintenance <on/off>', 'Maintenance mode (asks to confirm)'],
  ['/kitbot unlink <player>', 'Remove a link (asks to confirm)'],
  ['/kitbot cooldown-reset <player>', 'Reset a cooldown (asks to confirm)'],
  ['/kitbot quota-reset <player>', 'Reset a quota (asks to confirm)'],
  ['/kitbot ban <player> [reason]', 'Ban a player from the kit bot'],
  ['/kitbot unban <player>', 'Lift a ban'],
  ['/kitbot bans', 'Banned players'],
  ['/kitbot stock', 'Kits left in each chest'],
  ['/kitbot recalibrate', 'Look for the kit chests again'],
  ['/kitbot say <message>', 'Say something in the Minecraft chat'],
  ['/kitbot reload', 'Reload the settings'],
  ['/kitbot logs', 'Recent events'],
  ['/kitbot help', 'This list']
];

// The real protection (Discord's permission only hides the command): the
// user must be an administrator and the command must come from our server.
function isAdmin({ userId, guildId }, { adminIds, guildId: ourGuild }) {
  return /^\d{15,22}$/.test(String(userId)) && !!guildId && guildId === ourGuild && adminIds.includes(userId);
}

function createConfirmations({ ttlMs = 60000, now = () => Date.now() } = {}) {
  const pending = new Map();
  return {
    create(adminId, action, args) {
      for (const [k, v] of pending) if (v.expiresAt <= now()) pending.delete(k);
      const nonce = crypto.randomBytes(12).toString('hex');
      pending.set(nonce, { adminId, action, args, expiresAt: now() + ttlMs });
      return nonce;
    },
    // Single use.
    consume(nonce, adminId) {
      const e = pending.get(nonce);
      if (!e) return { ok: false, reason: 'expired' };
      if (e.adminId !== adminId) return { ok: false, reason: 'not_yours' };
      pending.delete(nonce);
      return e.expiresAt <= now() ? { ok: false, reason: 'expired' } : { ok: true, action: e.action, args: e.args };
    },
    cancel(nonce, adminId) {
      if (pending.get(nonce)?.adminId === adminId) pending.delete(nonce);
    }
  };
}

// Minecraft name, @mention or Discord ID -> { discordId, links } | null
async function findPlayer(db, query) {
  const t = bans.parseTarget(query);
  if (!t) return null;
  if (t.discordId) return { discordId: t.discordId, links: await linking.allLinksForDiscord(db, t.discordId) };
  const row = (await linking.activeLinkByUsername(db, t.name)) || (await db.get('SELECT * FROM links WHERE mc_username_lower = ? ORDER BY linked_at DESC LIMIT 1', [t.name.toLowerCase()]));
  return row ? { discordId: row.discord_id, links: await linking.allLinksForDiscord(db, row.discord_id) } : null;
}

function createAdminActions({ db, logger, getSettings }) {
  const audit = (admin, action, detail = '') => logger.admin(`admin.${action}`, `${admin.tag} (${admin.id}) ran /kitbot ${action}${detail ? `: ${detail}` : ''}`);
  return {
    async status() {
      const st = await getStatuses(db);
      const counts = Object.fromEntries((await db.all("SELECT status, COUNT(*) AS n FROM requests WHERE status IN ('queued', 'processing') GROUP BY status")).map((r) => [r.status, Number(r.n)]));
      return {
        minecraft: st.minecraft || null,
        discord: st.discord || null,
        paused: !!(await getSetting(db, 'paused', false)),
        maintenance: !!(await getSetting(db, 'maintenance', false)),
        queued: counts.queued || 0,
        processing: counts.processing || 0,
        errors: await recentEvents(db, 5, ['ERROR'])
      };
    },
    stats: () => globalStats(db),
    async player(query) {
      const p = await findPlayer(db, query);
      if (!p) return null;
      return { ...p, history: await linking.history(db, p.discordId, 5), usage: await limits.usage(db, p.discordId, getSettings().limits), stats: await playerStats(db, p.discordId) };
    },
    queue: () => queueSnapshot(db),
    async pause(admin) {
      await setSetting(db, 'paused', true);
      await audit(admin, 'pause');
    },
    async resume(admin) {
      await setSetting(db, 'paused', false);
      await audit(admin, 'resume');
    },
    async maintenance(admin, on) {
      await setSetting(db, 'maintenance', !!on);
      await audit(admin, 'maintenance', on ? 'on' : 'off');
    },
    async unlink(admin, query) {
      const t = bans.parseTarget(query);
      let revoked = [];
      if (t?.name) {
        const l = await linking.revokeByUsername(db, t.name, `unlinked by admin ${admin.id}`);
        if (l) revoked = [l];
      } else if (t?.discordId) revoked = await linking.revokeLinks(db, t.discordId, `unlinked by admin ${admin.id}`);
      await audit(admin, 'unlink', `${query}: ${revoked.length} link(s) removed`);
      return revoked;
    },
    async cooldownReset(admin, query) {
      const p = await findPlayer(db, query);
      if (p) {
        await limits.resetCooldown(db, p.discordId);
        await audit(admin, 'cooldown-reset', query);
      }
      return p;
    },
    async quotaReset(admin, query) {
      const p = await findPlayer(db, query);
      if (p) {
        await limits.resetQuota(db, p.discordId);
        await audit(admin, 'quota-reset', query);
      }
      return p;
    },
    async ban(admin, query, reason) {
      const r = await bans.ban(db, { query, reason, by: admin.id });
      if (r.ok) await audit(admin, 'ban', `${[r.name, r.discordId && `<@${r.discordId}>`].filter(Boolean).join(' / ')}${reason ? ` (${reason})` : ''}`);
      return r;
    },
    async unban(admin, query) {
      const n = await bans.unban(db, query);
      if (n) await audit(admin, 'unban', query);
      return n;
    },
    bans: () => bans.listBans(db),
    async stock() {
      return { stock: await readStock(db), lowThreshold: getSettings().stock.lowThreshold };
    },
    async recalibrate(admin) {
      await setSetting(db, 'station_recalibrate_at', Date.now());
      await audit(admin, 'recalibrate');
    },
    // A public chat message; commands ("/...") are refused.
    async say(admin, text) {
      const message = String(text || '')
        .replace(/[\u0000-\u001f\u007f§]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!message) return { ok: false, reason: 'empty' };
      if (message.startsWith('/')) return { ok: false, reason: 'command' };
      if (message.length > 256) return { ok: false, reason: 'too_long' };
      await db.run('INSERT INTO chat_outbox (message, requested_by, created_at) VALUES (?, ?, ?)', [message, admin.id, Date.now()]);
      await audit(admin, 'say', message);
      return { ok: true, message };
    },
    async reload(admin) {
      const { errors } = loadSettings();
      if (errors.length) return { ok: false, errors };
      await setSetting(db, 'reload_requested_at', Date.now());
      await audit(admin, 'reload');
      return { ok: true };
    },
    logs: () => recentEvents(db, 15),
    help: () => HELP
  };
}

module.exports = { SENSITIVE, HELP, isAdmin, createConfirmations, findPlayer, createAdminActions };
