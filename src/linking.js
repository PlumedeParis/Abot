'use strict';

// Discord <-> Minecraft account linking.
//
// Flow:
//  1. In Discord the player runs /link minecraft_username:<name>. The bot checks
//     server membership and issues a random single-use code (stored hashed),
//     bound to that Discord account AND that Minecraft username.
//  2. In Minecraft the player sends "!link <CODE>" (preferably by whisper).
//     Because the message must come from the in-game player whose name matches
//     the code, only someone logged into that Minecraft account can finish the
//     link. Typing someone else's username in Discord achieves nothing.
//
// Username changes: a Discord account may change its linked Minecraft account
// once every usernameChangeCooldownDays, measured from the last time the linked
// username was set (initial link or change). This is computed from the stored
// history, so reconnecting, leaving/rejoining Discord or being unlinked never
// resets it.

const crypto = require('node:crypto');

const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_RE = /^[A-Z0-9]{4}-?[A-Z0-9]{4}$/i;

function isValidUsername(name) {
  return typeof name === 'string' && USERNAME_RE.test(name);
}

function generateCode() {
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

function hashCode(code) {
  const norm = String(code).toUpperCase().replace(/-/g, '');
  return crypto.createHash('sha256').update(norm).digest('hex');
}

async function getActiveLinkByUsername(q, mcUsername) {
  return q.get("SELECT * FROM links WHERE mc_username_lower = ? AND verification_status = 'verified'", [String(mcUsername).toLowerCase()]);
}

async function getActiveLinksForDiscord(q, discordId) {
  return q.all("SELECT * FROM links WHERE discord_id = ? AND verification_status = 'verified' ORDER BY linked_at", [discordId]);
}

async function getAnyLinksForDiscord(q, discordId) {
  return q.all('SELECT * FROM links WHERE discord_id = ? ORDER BY linked_at DESC', [discordId]);
}

async function getHistory(q, discordId, limit = 10) {
  return q.all('SELECT * FROM username_history WHERE discord_id = ? ORDER BY created_at DESC, id DESC LIMIT ?', [discordId, limit]);
}

async function lastUsernameSet(q, discordId) {
  return q.get("SELECT new_username, created_at FROM username_history WHERE discord_id = ? AND action IN ('link', 'change') ORDER BY created_at DESC, id DESC LIMIT 1", [
    discordId
  ]);
}

// Decides whether this Discord account may link `mcUsername` now.
// Returns { ok, mode: 'new'|'change', replaceLink } or { ok: false, reason, ... }.
async function evaluateLink(q, { discordId, mcUsername, replaceUsername, settings, now }) {
  const cfg = settings.linking;
  const lower = mcUsername.toLowerCase();
  const cooldownMs = cfg.usernameChangeCooldownDays * 86400000;

  const owner = await getActiveLinkByUsername(q, mcUsername);
  if (owner && owner.discord_id !== discordId) return { ok: false, reason: 'taken' };
  if (owner && owner.discord_id === discordId) return { ok: false, reason: 'already_linked' };

  const active = await getActiveLinksForDiscord(q, discordId);
  const last = await lastUsernameSet(q, discordId);
  const tooSoon = last && now - Number(last.created_at) < cooldownMs;
  const retryAt = last ? Number(last.created_at) + cooldownMs : 0;

  if (active.length >= cfg.maxLinksPerDiscord) {
    let replaceLink;
    if (active.length === 1 && !replaceUsername) replaceLink = active[0];
    else replaceLink = active.find((l) => l.mc_username_lower === String(replaceUsername || '').toLowerCase());
    if (!replaceLink) return { ok: false, reason: 'limit_reached', active };
    if (tooSoon) return { ok: false, reason: 'change_too_soon', retryAt };
    return { ok: true, mode: 'change', replaceLink };
  }

  // Re-linking a different username after an unlink/revocation is a change too,
  // otherwise unlinking would bypass the cooldown.
  if (active.length === 0 && last && last.new_username.toLowerCase() !== lower && tooSoon) {
    return { ok: false, reason: 'change_too_soon', retryAt };
  }
  return { ok: true, mode: 'new', replaceLink: null };
}

async function startLink(db, { discordId, mcUsername, replaceUsername = null, settings, now = Date.now() }) {
  if (!isValidUsername(mcUsername)) return { ok: false, reason: 'invalid_username' };
  return db.transaction(async (tx) => {
    const ev = await evaluateLink(tx, { discordId, mcUsername, replaceUsername, settings, now });
    if (!ev.ok) return ev;
    // Only one live code per Discord account.
    await tx.run('UPDATE link_codes SET used_at = ? WHERE discord_id = ? AND used_at IS NULL', [now, discordId]);
    const code = generateCode();
    const expiresAt = now + settings.linking.codeTtlMinutes * 60000;
    await tx.run(
      `INSERT INTO link_codes (code_hash, discord_id, mc_username, mc_username_lower, replace_link_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [hashCode(code), discordId, mcUsername, mcUsername.toLowerCase(), ev.replaceLink ? ev.replaceLink.id : null, now, expiresAt]
    );
    return { ok: true, code, expiresAt, mode: ev.mode, replacing: ev.replaceLink ? ev.replaceLink.mc_username : null };
  });
}

async function recordAttempt(db, lower, success, now) {
  await db.run('INSERT INTO link_attempts (mc_username_lower, success, created_at) VALUES (?, ?, ?)', [lower, success ? 1 : 0, now]);
}

// Called when an in-game player sends "!link CODE".
// checkMembership(discordId) -> Promise<{ status: 'member'|'not_member'|'unavailable' }>
async function completeLink(db, { mcUsername, mcUuid = null, code, settings, checkMembership, now = Date.now() }) {
  if (!isValidUsername(mcUsername)) return { ok: false, reason: 'invalid_username' };
  const lower = mcUsername.toLowerCase();
  const failed = await db.get('SELECT COUNT(*) AS n FROM link_attempts WHERE mc_username_lower = ? AND success = 0 AND created_at > ?', [lower, now - 3600000]);
  if (Number(failed.n) >= settings.linking.maxFailedCodeAttemptsPerHour) return { ok: false, reason: 'too_many_attempts' };

  if (!CODE_RE.test(String(code || ''))) {
    await recordAttempt(db, lower, false, now);
    return { ok: false, reason: 'invalid_code' };
  }
  const row = await db.get('SELECT * FROM link_codes WHERE code_hash = ?', [hashCode(code)]);
  if (!row || row.used_at || Number(row.expires_at) <= now || row.mc_username_lower !== lower) {
    await recordAttempt(db, lower, false, now);
    return { ok: false, reason: row && Number(row.expires_at) <= now && !row.used_at && row.mc_username_lower === lower ? 'expired_code' : 'invalid_code' };
  }

  const membership = await checkMembership(row.discord_id);
  if (membership.status === 'unavailable') return { ok: false, reason: 'discord_unavailable' };
  if (membership.status !== 'member') return { ok: false, reason: membership.status === 'missing_role' ? 'missing_role' : 'not_member' };

  try {
    const result = await db.transaction(async (tx) => {
      const claimed = await tx.run('UPDATE link_codes SET used_at = ? WHERE id = ? AND used_at IS NULL', [now, row.id]);
      if (claimed.changes !== 1) return { ok: false, reason: 'invalid_code' };

      // Validate everything again inside the transaction before replacing anything.
      const old = row.replace_link_id
        ? await tx.get("SELECT * FROM links WHERE id = ? AND discord_id = ? AND verification_status = 'verified'", [row.replace_link_id, row.discord_id])
        : null;
      if (row.replace_link_id && !old) return { ok: false, reason: 'link_changed' };
      const ev = await evaluateLink(tx, { discordId: row.discord_id, mcUsername, replaceUsername: old ? old.mc_username : null, settings, now });
      if (!ev.ok) return ev;
      if (mcUuid) {
        const uuidOwner = await tx.get("SELECT * FROM links WHERE mc_uuid = ? AND verification_status = 'verified'", [mcUuid]);
        if (uuidOwner && uuidOwner.discord_id !== row.discord_id) return { ok: false, reason: 'taken' };
      }

      if (old) {
        if (ev.mode !== 'change' || ev.replaceLink.id !== old.id) return { ok: false, reason: 'link_changed' };
        await tx.run('UPDATE links SET mc_username = ?, mc_username_lower = ?, mc_uuid = ?, last_username_change_at = ? WHERE id = ?', [
          mcUsername,
          lower,
          mcUuid,
          now,
          old.id
        ]);
        await tx.run(
          `INSERT INTO username_history (discord_id, link_id, action, old_username, new_username, old_uuid, new_uuid, created_at)
           VALUES (?, ?, 'change', ?, ?, ?, ?, ?)`,
          [row.discord_id, old.id, old.mc_username, mcUsername, old.mc_uuid, mcUuid, now]
        );
        const link = await tx.get('SELECT * FROM links WHERE id = ?', [old.id]);
        return { ok: true, mode: 'change', link, previous: old.mc_username };
      }

      if (ev.mode !== 'new') return { ok: false, reason: 'link_changed' };
      const link = await tx.get(
        `INSERT INTO links (discord_id, mc_username, mc_username_lower, mc_uuid, linked_at, verification_status)
         VALUES (?, ?, ?, ?, ?, 'verified') RETURNING *`,
        [row.discord_id, mcUsername, lower, mcUuid, now]
      );
      await tx.run(
        `INSERT INTO username_history (discord_id, link_id, action, new_username, new_uuid, created_at)
         VALUES (?, ?, 'link', ?, ?, ?)`,
        [row.discord_id, link.id, mcUsername, mcUuid, now]
      );
      return { ok: true, mode: 'new', link };
    });
    await recordAttempt(db, lower, result.ok, now);
    return { ...result, discordId: row.discord_id };
  } catch (e) {
    if (/unique|duplicate/i.test(e.message)) return { ok: false, reason: 'taken' };
    throw e;
  }
}

async function revokeLinks(db, discordId, reason, now = Date.now()) {
  return db.transaction(async (tx) => {
    const links = await getActiveLinksForDiscord(tx, discordId);
    for (const l of links) {
      await tx.run("UPDATE links SET verification_status = 'revoked', revoked_at = ?, revoked_reason = ? WHERE id = ?", [now, reason, l.id]);
      await tx.run(
        `INSERT INTO username_history (discord_id, link_id, action, old_username, old_uuid, reason, created_at)
         VALUES (?, ?, 'revoke', ?, ?, ?, ?)`,
        [discordId, l.id, l.mc_username, l.mc_uuid, reason, now]
      );
    }
    // Cancel unused codes and drop queued requests: access is gone.
    await tx.run('UPDATE link_codes SET used_at = ? WHERE discord_id = ? AND used_at IS NULL', [now, discordId]);
    await tx.run("UPDATE requests SET status = 'cancelled', completed_at = ?, error = ? WHERE discord_id = ? AND status = 'queued'", [now, `link revoked: ${reason}`, discordId]);
    return links;
  });
}

async function revokeByUsername(db, mcUsername, reason, now = Date.now()) {
  const link = await getActiveLinkByUsername(db, mcUsername);
  if (!link) return null;
  await db.transaction(async (tx) => {
    await tx.run("UPDATE links SET verification_status = 'revoked', revoked_at = ?, revoked_reason = ? WHERE id = ?", [now, reason, link.id]);
    await tx.run(
      `INSERT INTO username_history (discord_id, link_id, action, old_username, old_uuid, reason, created_at)
       VALUES (?, ?, 'revoke', ?, ?, ?, ?)`,
      [link.discord_id, link.id, link.mc_username, link.mc_uuid, reason, now]
    );
    await tx.run(
      "UPDATE requests SET status = 'cancelled', completed_at = ?, error = ? WHERE mc_username_lower = ? AND status = 'queued'",
      [now, `link revoked: ${reason}`, link.mc_username_lower]
    );
  });
  return link;
}

async function allActiveDiscordIds(db) {
  return (await db.all("SELECT DISTINCT discord_id FROM links WHERE verification_status = 'verified'")).map((r) => r.discord_id);
}

module.exports = {
  USERNAME_RE,
  isValidUsername,
  generateCode,
  hashCode,
  startLink,
  completeLink,
  revokeLinks,
  revokeByUsername,
  getActiveLinkByUsername,
  getActiveLinksForDiscord,
  getAnyLinksForDiscord,
  getHistory,
  allActiveDiscordIds,
  evaluateLink
};
