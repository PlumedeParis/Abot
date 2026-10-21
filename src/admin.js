'use strict';

// Administrator commands: authorisation, confirmations and the actions
// themselves. Kept free of discord.js objects so it can be unit-tested.

const crypto = require('node:crypto');
const { getSetting, setSetting, getStatuses } = require('./database');
const { loadSettings } = require('./config');
const linking = require('./linking');
const limits = require('./limits');
const { queueSnapshot, globalStats, playerStats } = require('./queue');
const { recentEvents } = require('./logging');

const SENSITIVE = new Set(['unlink', 'cooldown-reset', 'quota-reset', 'maintenance']);

const HELP = [
  ['/kitbot status', 'Bot, Minecraft and Discord status, queue and recent errors'],
  ['/kitbot stats', 'Global request and delivery statistics'],
  ['/kitbot player <username>', 'Link status and statistics of a player'],
  ['/kitbot queue', 'Pending requests'],
  ['/kitbot pause', 'Pause kit deliveries'],
  ['/kitbot resume', 'Resume kit deliveries'],
  ['/kitbot maintenance <enabled>', 'Turn maintenance mode on or off (confirmation)'],
  ['/kitbot unlink <player>', 'Revoke a player link (confirmation)'],
  ['/kitbot cooldown-reset <player>', 'Reset a player cooldown (confirmation)'],
  ['/kitbot quota-reset <player>', 'Reset a player quota (confirmation)'],
  ['/kitbot reload', 'Reload non-secret settings'],
  ['/kitbot recalibrate', 'Re-detect the kit chests around the bot'],
  ['/kitbot say <message>', 'Send a message in the Minecraft chat as the bot'],
  ['/kitbot logs', 'Recent events'],
  ['/kitbot help', 'This list']
];

// Server-side authorisation. Discord's default_member_permissions only hides
// the command in the client; this check is what actually protects it.
// An administrator must be in the configured allowlist AND the interaction
// must come from the configured guild (not a DM or another server).
function isAuthorizedAdmin({ userId, guildId }, { adminIds, guildId: allowedGuild }) {
  if (typeof userId !== 'string' || !/^\d{15,22}$/.test(userId)) return false;
  if (!guildId || guildId !== allowedGuild) return false;
  return Array.isArray(adminIds) && adminIds.includes(userId);
}

function createConfirmationStore({ ttlMs = 60000, now = () => Date.now() } = {}) {
  const pending = new Map();
  return {
    create(adminId, action, args) {
      for (const [k, v] of pending) if (v.expiresAt <= now()) pending.delete(k);
      const nonce = crypto.randomBytes(12).toString('hex');
      pending.set(nonce, { adminId, action, args, expiresAt: now() + ttlMs });
      return nonce;
    },
    // Single use: the entry is removed whatever the outcome.
    consume(nonce, adminId) {
      const entry = pending.get(nonce);
      if (!entry) return { ok: false, reason: 'expired' };
      if (entry.adminId !== adminId) return { ok: false, reason: 'not_yours' };
      pending.delete(nonce);
      if (entry.expiresAt <= now()) return { ok: false, reason: 'expired' };
      return { ok: true, action: entry.action, args: entry.args };
    },
    cancel(nonce, adminId) {
      const entry = pending.get(nonce);
      if (entry && entry.adminId === adminId) pending.delete(nonce);
    }
  };
}

// Resolves "<minecraft name>", "<@mention>" or a Discord ID to a Discord ID.
async function resolvePlayer(db, query) {
  const q = String(query || '').trim();
  const mention = /^<@!?(\d{15,22})>$/.exec(q);
  if (mention || /^\d{15,22}$/.test(q)) {
    const discordId = mention ? mention[1] : q;
    const links = await linking.getAnyLinksForDiscord(db, discordId);
    return { discordId, links };
  }
  if (!linking.isValidUsername(q)) return null;
  const active = await linking.getActiveLinkByUsername(db, q);
  const row = active || (await db.get('SELECT * FROM links WHERE mc_username_lower = ? ORDER BY linked_at DESC LIMIT 1', [q.toLowerCase()]));
  if (!row) return null;
  return { discordId: row.discord_id, links: await linking.getAnyLinksForDiscord(db, row.discord_id) };
}

function createAdminActions({ db, logger, getSettings, onReload = () => {} }) {
  async function audit(admin, action, detail) {
    await logger.admin(`admin.${action}`, `${admin.tag || admin.id} (${admin.id}) ran /kitbot ${action}${detail ? `: ${detail}` : ''}`);
  }

  return {
    async status() {
      const statuses = await getStatuses(db);
      const q = await db.all("SELECT status, COUNT(*) AS n FROM requests WHERE status IN ('queued', 'processing') GROUP BY status");
      const counts = Object.fromEntries(q.map((r) => [r.status, Number(r.n)]));
      return {
        minecraft: statuses.minecraft || null,
        discord: statuses.discord || null,
        paused: !!(await getSetting(db, 'paused', false)),
        maintenance: !!(await getSetting(db, 'maintenance', false)),
        queued: counts.queued || 0,
        processing: counts.processing || 0,
        recentErrors: await recentEvents(db, 5, ['ERROR'])
      };
    },
    stats: () => globalStats(db),
    async player(query) {
      const p = await resolvePlayer(db, query);
      if (!p) return null;
      const s = getSettings();
      return {
        discordId: p.discordId,
        links: p.links,
        history: await linking.getHistory(db, p.discordId, 5),
        usage: await limits.usage(db, p.discordId, s.limits),
        stats: await playerStats(db, p.discordId)
      };
    },
    queue: () => queueSnapshot(db, 20),
    async pause(admin) {
      await setSetting(db, 'paused', true);
      await audit(admin, 'pause');
      return true;
    },
    async resume(admin) {
      await setSetting(db, 'paused', false);
      await audit(admin, 'resume');
      return true;
    },
    async maintenance(admin, enabled) {
      await setSetting(db, 'maintenance', !!enabled);
      await audit(admin, 'maintenance', enabled ? 'enabled' : 'disabled');
      await logger.warn(enabled ? 'maintenance.on' : 'maintenance.off', `Maintenance mode ${enabled ? 'enabled' : 'disabled'}.`);
      return true;
    },
    async unlink(admin, query) {
      const q = String(query || '').trim();
      let revoked = [];
      if (linking.isValidUsername(q)) {
        const link = await linking.revokeByUsername(db, q, `unlinked by admin ${admin.id}`);
        if (link) revoked = [link];
      } else {
        const p = await resolvePlayer(db, q);
        if (p) revoked = await linking.revokeLinks(db, p.discordId, `unlinked by admin ${admin.id}`);
      }
      await audit(admin, 'unlink', `${q} -> ${revoked.length} link(s) revoked`);
      for (const l of revoked) await logger.info('link.removed', `Unlinked ${l.mc_username} from <@${l.discord_id}> (admin action).`);
      return revoked;
    },
    async cooldownReset(admin, query) {
      const p = await resolvePlayer(db, query);
      if (!p) return null;
      await limits.resetCooldown(db, p.discordId);
      await audit(admin, 'cooldown-reset', `${query} (<@${p.discordId}>)`);
      return p;
    },
    async quotaReset(admin, query) {
      const p = await resolvePlayer(db, query);
      if (!p) return null;
      await limits.resetQuota(db, p.discordId);
      await audit(admin, 'quota-reset', `${query} (<@${p.discordId}>)`);
      return p;
    },
    async reload(admin) {
      const { settings, errors, source } = loadSettings();
      if (errors.length) {
        await audit(admin, 'reload', `rejected: ${errors.length} error(s)`);
        return { ok: false, errors };
      }
      onReload(settings);
      await setSetting(db, 'reload_requested_at', Date.now());
      await audit(admin, 'reload', `from ${source.startsWith('/') ? 'config file' : source}`);
      return { ok: true };
    },
    // Queues a public chat message; the Minecraft bot sends it within seconds.
    // Commands ("/...") are refused so this cannot run commands as the bot.
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
    async recalibrate(admin) {
      await setSetting(db, 'station_recalibrate_at', Date.now());
      await audit(admin, 'recalibrate');
      return true;
    },
    logs: () => recentEvents(db, 15),
    help: () => HELP
  };
}

module.exports = { isAuthorizedAdmin, createConfirmationStore, createAdminActions, resolvePlayer, SENSITIVE, HELP };
