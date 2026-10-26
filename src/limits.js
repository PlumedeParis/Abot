'use strict';

// Cooldowns, quotas and the global delivery rate, all per Discord account (so
// linking several Minecraft accounts never multiplies the allowance).
//   A request counts while queued or processing and after it ends "delivered"
//   or "unconfirmed". "failed", "cancelled" and "expired" never reached the
//   player and count for nothing.
//   Cooldown: cooldownMinutes between counted requests (all kits together).
//   Quota: at most dailyQuota counted requests in the last quotaWindowHours.
//   One pending request per player (also a unique index in the database).
//   Global: at most globalPerMinute deliveries start in any 60 seconds.

const COUNTED = "('queued', 'processing', 'delivered', 'unconfirmed')";

async function usage(q, discordId, limits, now = Date.now()) {
  const resets = await q.get('SELECT cooldown_reset_at, quota_reset_at FROM limit_resets WHERE discord_id = ?', [discordId]);
  const cooldownResetAt = Number(resets?.cooldown_reset_at || 0);
  const quotaResetAt = Number(resets?.quota_reset_at || 0);
  const pending = await q.get("SELECT id, kit FROM requests WHERE discord_id = ? AND status IN ('queued', 'processing') LIMIT 1", [discordId]);
  const last = await q.get(`SELECT created_at FROM requests WHERE discord_id = ? AND status IN ${COUNTED} AND created_at > ? ORDER BY created_at DESC LIMIT 1`, [discordId, cooldownResetAt]);
  const cooldownEndsAt = last ? Number(last.created_at) + limits.cooldownMinutes * 60000 : 0;
  const windowMs = limits.quotaWindowHours * 3600000;
  const inWindow = await q.all(`SELECT created_at FROM requests WHERE discord_id = ? AND status IN ${COUNTED} AND created_at > ? ORDER BY created_at ASC`, [
    discordId,
    Math.max(now - windowMs, quotaResetAt)
  ]);
  const used = inWindow.length;
  return {
    pending: pending || null,
    cooldownEndsAt,
    cooldownRemainingMs: Math.max(0, cooldownEndsAt - now),
    quotaUsed: used,
    quotaLimit: limits.dailyQuota,
    // The quota frees up when the oldest counted request leaves the window.
    quotaFreesAt: used >= limits.dailyQuota ? Number(inWindow[used - limits.dailyQuota].created_at) + windowMs : 0
  };
}

// Checks every limit and, if allowed, queues the request, atomically.
async function reserve(db, { discordId, name, kit, limits, now = Date.now() }) {
  try {
    return await db.transaction(async (tx) => {
      const u = await usage(tx, discordId, limits, now);
      if (u.pending) return { ok: false, reason: 'pending' };
      if (u.cooldownRemainingMs > 0) return { ok: false, reason: 'cooldown', retryAt: u.cooldownEndsAt };
      if (u.quotaUsed >= limits.dailyQuota) return { ok: false, reason: 'quota', retryAt: u.quotaFreesAt };
      const queued = await tx.get("SELECT COUNT(*) AS n FROM requests WHERE status = 'queued'");
      if (Number(queued.n) >= limits.maxQueueSize) return { ok: false, reason: 'queue_full' };
      const request = await tx.get("INSERT INTO requests (discord_id, mc_username, mc_username_lower, kit, status, attempts, created_at) VALUES (?, ?, ?, ?, 'queued', 0, ?) RETURNING *", [
        discordId,
        name,
        name.toLowerCase(),
        kit,
        now
      ]);
      const pos = await tx.get("SELECT COUNT(*) AS n FROM requests WHERE status IN ('queued', 'processing') AND id <= ?", [request.id]);
      return { ok: true, request, position: Number(pos.n) };
    });
  } catch (e) {
    if (/unique|duplicate/i.test(e.message)) return { ok: false, reason: 'pending' }; // concurrent request won
    throw e;
  }
}

// When the next delivery may start without exceeding perMinute.
async function nextGlobalSlot(db, perMinute, now = Date.now()) {
  const rows = await db.all('SELECT started_at FROM requests WHERE started_at > ? ORDER BY started_at ASC', [now - 60000]);
  return rows.length < perMinute ? now : Number(rows[rows.length - perMinute].started_at) + 60000;
}

const resetColumn = (column) => (db, discordId, now = Date.now()) =>
  db.run(`INSERT INTO limit_resets (discord_id, ${column}) VALUES (?, ?) ON CONFLICT (discord_id) DO UPDATE SET ${column} = excluded.${column}`, [discordId, now]);

function formatDuration(ms) {
  const s = Math.max(1, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

module.exports = { usage, reserve, nextGlobalSlot, resetCooldown: resetColumn('cooldown_reset_at'), resetQuota: resetColumn('quota_reset_at'), formatDuration };
