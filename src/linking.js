'use strict';

// Linking a Discord account to a Minecraft account.
//   1. Discord: /link minecraft_username:<name> -> a single-use code, stored
//      hashed and bound to that Discord account and that Minecraft name.
//   2. Minecraft: the player whispers "!link <code>" to the bot. Only someone
//      logged in as that Minecraft name can send it, so typing another
//      player's name in Discord achieves nothing.
// A Discord account may change its linked Minecraft name once every
// usernameChangeCooldownDays, measured from the history, so unlinking or
// leaving the server never resets it.

const crypto = require('node:crypto');

const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_RE = /^[A-Z0-9]{4}-?[A-Z0-9]{4}$/i;

const isValidUsername = (name) => typeof name === 'string' && USERNAME_RE.test(name);

function generateCode() {
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

const hashCode = (code) => crypto.createHash('sha256').update(String(code).toUpperCase().replace(/-/g, '')).digest('hex');

const activeLinkByUsername = (q, name) => q.get("SELECT * FROM links WHERE mc_username_lower = ? AND verification_status = 'verified'", [String(name).toLowerCase()]);
const activeLinksForDiscord = (q, id) => q.all("SELECT * FROM links WHERE discord_id = ? AND verification_status = 'verified' ORDER BY linked_at", [id]);
const allLinksForDiscord = (q, id) => q.all('SELECT * FROM links WHERE discord_id = ? ORDER BY linked_at DESC', [id]);
const history = (q, id, limit = 10) => q.all('SELECT * FROM username_history WHERE discord_id = ? ORDER BY created_at DESC, id DESC LIMIT ?', [id, limit]);

// Whether `discordId` may link `name` now: { ok, mode: 'new'|'change', replace } or { ok: false, reason }.
async function evaluate(q, { discordId, name, replaceName, settings, now }) {
  const owner = await activeLinkByUsername(q, name);
  if (owner) return { ok: false, reason: owner.discord_id === discordId ? 'already_linked' : 'taken' };

  const active = await activeLinksForDiscord(q, discordId);
  const last = await q.get("SELECT new_username, created_at FROM username_history WHERE discord_id = ? AND action IN ('link', 'change') ORDER BY created_at DESC, id DESC LIMIT 1", [discordId]);
  const cooldownMs = settings.linking.usernameChangeCooldownDays * 86400000;
  const retryAt = last ? Number(last.created_at) + cooldownMs : 0;
  const tooSoon = last && now < retryAt;

  if (active.length >= settings.linking.maxLinksPerDiscord) {
    const replace = active.length === 1 && !replaceName ? active[0] : active.find((l) => l.mc_username_lower === String(replaceName || '').toLowerCase());
    if (!replace) return { ok: false, reason: 'limit_reached' };
    if (tooSoon) return { ok: false, reason: 'change_too_soon', retryAt };
    return { ok: true, mode: 'change', replace };
  }
  // Linking another name after an unlink counts as a change too.
  if (!active.length && last && last.new_username.toLowerCase() !== name.toLowerCase() && tooSoon) return { ok: false, reason: 'change_too_soon', retryAt };
  return { ok: true, mode: 'new', replace: null };
}

async function startLink(db, { discordId, name, replaceName = null, settings, now = Date.now() }) {
  if (!isValidUsername(name)) return { ok: false, reason: 'invalid_username' };
  return db.transaction(async (tx) => {
    const ev = await evaluate(tx, { discordId, name, replaceName, settings, now });
    if (!ev.ok) return ev;
    await tx.run('UPDATE link_codes SET used_at = ? WHERE discord_id = ? AND used_at IS NULL', [now, discordId]); // one live code
    const code = generateCode();
    const expiresAt = now + settings.linking.codeTtlMinutes * 60000;
    await tx.run(
      'INSERT INTO link_codes (code_hash, discord_id, mc_username, mc_username_lower, replace_link_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [hashCode(code), discordId, name, name.toLowerCase(), ev.replace ? ev.replace.id : null, now, expiresAt]
    );
    return { ok: true, code, expiresAt, replacing: ev.replace ? ev.replace.mc_username : null };
  });
}

const recordAttempt = (db, lower, success, now) => db.run('INSERT INTO link_attempts (mc_username_lower, success, created_at) VALUES (?, ?, ?)', [lower, success ? 1 : 0, now]);

// In game "!link CODE" from player `name`.
async function completeLink(db, { name, uuid = null, code, settings, checkMembership, now = Date.now() }) {
  if (!isValidUsername(name)) return { ok: false, reason: 'invalid_username' };
  const lower = name.toLowerCase();
  const failed = await db.get('SELECT COUNT(*) AS n FROM link_attempts WHERE mc_username_lower = ? AND success = 0 AND created_at > ?', [lower, now - 3600000]);
  if (Number(failed.n) >= settings.linking.maxFailedCodeAttemptsPerHour) return { ok: false, reason: 'too_many_attempts' };

  const row = CODE_RE.test(String(code || '')) ? await db.get('SELECT * FROM link_codes WHERE code_hash = ?', [hashCode(code)]) : null;
  if (!row || row.used_at || row.mc_username_lower !== lower || Number(row.expires_at) <= now) {
    await recordAttempt(db, lower, false, now);
    const expired = row && !row.used_at && row.mc_username_lower === lower && Number(row.expires_at) <= now;
    return { ok: false, reason: expired ? 'expired_code' : 'invalid_code' };
  }

  const m = await checkMembership(row.discord_id);
  if (m.status === 'unavailable') return { ok: false, reason: 'discord_unavailable' };
  if (m.status !== 'member') return { ok: false, reason: m.status === 'missing_role' ? 'missing_role' : 'not_member' };

  try {
    const result = await db.transaction(async (tx) => {
      const claimed = await tx.run('UPDATE link_codes SET used_at = ? WHERE id = ? AND used_at IS NULL', [now, row.id]);
      if (claimed.changes !== 1) return { ok: false, reason: 'invalid_code' };
      const old = row.replace_link_id ? await tx.get("SELECT * FROM links WHERE id = ? AND discord_id = ? AND verification_status = 'verified'", [row.replace_link_id, row.discord_id]) : null;
      if (row.replace_link_id && !old) return { ok: false, reason: 'link_changed' };
      const ev = await evaluate(tx, { discordId: row.discord_id, name, replaceName: old ? old.mc_username : null, settings, now });
      if (!ev.ok) return ev;
      if (uuid) {
        const uuidOwner = await tx.get("SELECT discord_id FROM links WHERE mc_uuid = ? AND verification_status = 'verified'", [uuid]);
        if (uuidOwner && uuidOwner.discord_id !== row.discord_id) return { ok: false, reason: 'taken' };
      }
      if (old) {
        if (ev.mode !== 'change' || ev.replace.id !== old.id) return { ok: false, reason: 'link_changed' };
        await tx.run('UPDATE links SET mc_username = ?, mc_username_lower = ?, mc_uuid = ?, last_username_change_at = ? WHERE id = ?', [name, lower, uuid, now, old.id]);
        await tx.run(
          "INSERT INTO username_history (discord_id, link_id, action, old_username, new_username, old_uuid, new_uuid, created_at) VALUES (?, ?, 'change', ?, ?, ?, ?, ?)",
          [row.discord_id, old.id, old.mc_username, name, old.mc_uuid, uuid, now]
        );
        return { ok: true, mode: 'change', previous: old.mc_username };
      }
      if (ev.mode !== 'new') return { ok: false, reason: 'link_changed' };
      const link = await tx.get("INSERT INTO links (discord_id, mc_username, mc_username_lower, mc_uuid, linked_at, verification_status) VALUES (?, ?, ?, ?, ?, 'verified') RETURNING *", [
        row.discord_id,
        name,
        lower,
        uuid,
        now
      ]);
      await tx.run("INSERT INTO username_history (discord_id, link_id, action, new_username, new_uuid, created_at) VALUES (?, ?, 'link', ?, ?, ?)", [row.discord_id, link.id, name, uuid, now]);
      return { ok: true, mode: 'new' };
    });
    await recordAttempt(db, lower, result.ok, now);
    return { ...result, discordId: row.discord_id };
  } catch (e) {
    if (/unique|duplicate/i.test(e.message)) return { ok: false, reason: 'taken' };
    throw e;
  }
}

async function revokeRows(tx, links, reason, now) {
  for (const l of links) {
    await tx.run("UPDATE links SET verification_status = 'revoked', revoked_at = ?, revoked_reason = ? WHERE id = ?", [now, reason, l.id]);
    await tx.run("INSERT INTO username_history (discord_id, link_id, action, old_username, old_uuid, reason, created_at) VALUES (?, ?, 'revoke', ?, ?, ?, ?)", [
      l.discord_id,
      l.id,
      l.mc_username,
      l.mc_uuid,
      reason,
      now
    ]);
    // Access is gone: waiting orders are cancelled (they do not count).
    await tx.run("UPDATE requests SET status = 'cancelled', completed_at = ?, error = ? WHERE mc_username_lower = ? AND status = 'queued'", [now, `link revoked: ${reason}`, l.mc_username_lower]);
  }
}

// Revokes every link of a Discord account (e.g. it left the server).
async function revokeLinks(db, discordId, reason, now = Date.now()) {
  return db.transaction(async (tx) => {
    const links = await activeLinksForDiscord(tx, discordId);
    await revokeRows(tx, links, reason, now);
    await tx.run('UPDATE link_codes SET used_at = ? WHERE discord_id = ? AND used_at IS NULL', [now, discordId]);
    return links;
  });
}

async function revokeByUsername(db, name, reason, now = Date.now()) {
  return db.transaction(async (tx) => {
    const link = await activeLinkByUsername(tx, name);
    if (link) await revokeRows(tx, [link], reason, now);
    return link || null;
  });
}

const allActiveDiscordIds = async (db) => (await db.all("SELECT DISTINCT discord_id FROM links WHERE verification_status = 'verified'")).map((r) => r.discord_id);

module.exports = {
  isValidUsername,
  generateCode,
  hashCode,
  startLink,
  completeLink,
  revokeLinks,
  revokeByUsername,
  activeLinkByUsername,
  activeLinksForDiscord,
  allLinksForDiscord,
  history,
  allActiveDiscordIds
};
