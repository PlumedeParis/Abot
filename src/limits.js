'use strict';

// Cooldowns, rolling quotas and the global delivery rate.
//
// Policy (all limits are keyed by Discord account, so linking several
// Minecraft accounts never multiplies a player's allowance):
//  - A request "counts" while it is queued or processing, and after it ends as
//    "delivered" or "unconfirmed" (the kit left the bot but pickup could not be
//    confirmed). Requests that end as "failed", "cancelled" or "expired" never
//    reached the player and are refunded: they count towards neither the
//    cooldown nor the quota.
//  - Cooldown: cooldownMinutes between ACCEPTED requests, shared by all kits,
//    measured from the moment a request was accepted into the queue.
//  - Quota: at most dailyQuota counted requests in any rolling window of
//    quotaWindowHours (default 24h) ending now.
//  - One pending (queued/processing) request per player at a time, enforced by
//    a unique index as well.
//  - Global: at most globalPerMinute deliveries may START in any 60s window.

const COUNTED = ['queued', 'processing', 'delivered', 'unconfirmed'];
const PENDING = ['queued', 'processing'];
const inList = (arr) => arr.map((s) => `'${s}'`).join(', ');

async function getResets(q, discordId) {
  const row = await q.get('SELECT cooldown_reset_at, quota_reset_at FROM limit_resets WHERE discord_id = ?', [discordId]);
  return { cooldownResetAt: Number(row?.cooldown_reset_at || 0), quotaResetAt: Number(row?.quota_reset_at || 0) };
}

async function evaluate(q, discordId, limits, now) {
  const cooldownMs = limits.cooldownMinutes * 60000;
  const windowMs = limits.quotaWindowHours * 3600000;
  const resets = await getResets(q, discordId);

  const pending = await q.get(`SELECT id, kit, status FROM requests WHERE discord_id = ? AND status IN (${inList(PENDING)}) LIMIT 1`, [discordId]);

  const last = await q.get(
    `SELECT created_at FROM requests WHERE discord_id = ? AND status IN (${inList(COUNTED)}) AND created_at > ? ORDER BY created_at DESC LIMIT 1`,
    [discordId, resets.cooldownResetAt]
  );
  const cooldownEndsAt = last ? Number(last.created_at) + cooldownMs : 0;

  const windowStart = Math.max(now - windowMs, resets.quotaResetAt);
  const inWindow = await q.all(
    `SELECT created_at FROM requests WHERE discord_id = ? AND status IN (${inList(COUNTED)}) AND created_at > ? ORDER BY created_at ASC`,
    [discordId, windowStart]
  );
  const used = inWindow.length;
  // The quota frees up when the oldest counted request leaves the window.
  const quotaFreesAt = used >= limits.dailyQuota ? Number(inWindow[used - limits.dailyQuota].created_at) + windowMs : 0;

  return {
    pending: pending || null,
    cooldownRemainingMs: Math.max(0, cooldownEndsAt - now),
    cooldownEndsAt,
    quotaUsed: used,
    quotaLimit: limits.dailyQuota,
    quotaFreesAt
  };
}

// Atomically checks every limit and, if allowed, inserts the queued request.
async function reserve(db, { discordId, mcUsername, kit, limits, now = Date.now() }) {
  try {
    return await db.transaction(async (tx) => {
      const u = await evaluate(tx, discordId, limits, now);
      if (u.pending) return { ok: false, reason: 'pending', usage: u };
      if (u.cooldownRemainingMs > 0) return { ok: false, reason: 'cooldown', retryAt: u.cooldownEndsAt, usage: u };
      if (u.quotaUsed >= limits.dailyQuota) return { ok: false, reason: 'quota', retryAt: u.quotaFreesAt, usage: u };

      const queued = await tx.get("SELECT COUNT(*) AS n FROM requests WHERE status = 'queued'");
      if (Number(queued.n) >= limits.maxQueueSize) return { ok: false, reason: 'queue_full', usage: u };

      const row = await tx.get(
        `INSERT INTO requests (discord_id, mc_username, mc_username_lower, kit, status, attempts, created_at)
         VALUES (?, ?, ?, ?, 'queued', 0, ?) RETURNING *`,
        [discordId, mcUsername, mcUsername.toLowerCase(), kit, now]
      );
      const pos = await tx.get("SELECT COUNT(*) AS n FROM requests WHERE status IN ('queued', 'processing') AND id <= ?", [row.id]);
      return { ok: true, request: row, position: Number(pos.n), usage: u };
    });
  } catch (e) {
    // Unique index violation: a concurrent request for the same player won the race.
    if (/unique|duplicate/i.test(e.message)) return { ok: false, reason: 'pending' };
    throw e;
  }
}

async function usage(db, discordId, limits, now = Date.now()) {
  return evaluate(db, discordId, limits, now);
}

// When may the next delivery start without exceeding globalPerMinute?
async function nextGlobalSlot(db, perMinute, now = Date.now()) {
  const rows = await db.all('SELECT started_at FROM requests WHERE started_at IS NOT NULL AND started_at > ? ORDER BY started_at ASC', [now - 60000]);
  if (rows.length < perMinute) return now;
  return Number(rows[rows.length - perMinute].started_at) + 60000;
}

async function upsertReset(db, discordId, column, now) {
  await db.run(
    `INSERT INTO limit_resets (discord_id, ${column}) VALUES (?, ?)
     ON CONFLICT (discord_id) DO UPDATE SET ${column} = excluded.${column}`,
    [discordId, now]
  );
}

const resetCooldown = (db, discordId, now = Date.now()) => upsertReset(db, discordId, 'cooldown_reset_at', now);
const resetQuota = (db, discordId, now = Date.now()) => upsertReset(db, discordId, 'quota_reset_at', now);

function formatDuration(ms) {
  const s = Math.max(1, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

module.exports = { COUNTED, PENDING, reserve, usage, nextGlobalSlot, resetCooldown, resetQuota, formatDuration };
