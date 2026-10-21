'use strict';

// Players banned from the kit bot. A ban targets a Minecraft username and,
// when that player has a linked account, their Discord account too, so
// linking another Minecraft account does not get around it.

const linking = require('./linking');

async function findBan(db, { mcUsername = null, discordId = null }) {
  const lower = mcUsername ? String(mcUsername).toLowerCase() : null;
  if (!lower && !discordId) return null;
  return db.get('SELECT * FROM bans WHERE (mc_username_lower IS NOT NULL AND mc_username_lower = ?) OR (discord_id IS NOT NULL AND discord_id = ?) ORDER BY id LIMIT 1', [
    lower,
    discordId
  ]);
}

// query: a Minecraft username, a Discord @mention or a Discord user ID.
async function banPlayer(db, { query, reason = null, bannedBy, now = Date.now() }) {
  const q = String(query || '').trim();
  const mention = /^<@!?(\d{15,22})>$/.exec(q);
  let mcUsername = null;
  let discordId = null;
  if (mention || /^\d{15,22}$/.test(q)) {
    discordId = mention ? mention[1] : q;
  } else if (linking.isValidUsername(q)) {
    mcUsername = q;
    const link = await linking.getActiveLinkByUsername(db, q);
    if (link) discordId = link.discord_id;
  } else {
    return { ok: false, reason: 'invalid' };
  }
  if (await findBan(db, { mcUsername, discordId })) return { ok: false, reason: 'already_banned' };
  await db.transaction(async (tx) => {
    await tx.run('INSERT INTO bans (mc_username_lower, mc_username, discord_id, reason, banned_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      mcUsername ? mcUsername.toLowerCase() : null,
      mcUsername,
      discordId,
      reason,
      bannedBy,
      now
    ]);
    // Unused link codes stop working, so no new account can be linked with them.
    if (discordId) await tx.run('UPDATE link_codes SET used_at = ? WHERE discord_id = ? AND used_at IS NULL', [now, discordId]);
    // Their waiting orders are cancelled (and do not count).
    await tx.run(
      "UPDATE requests SET status = 'cancelled', completed_at = ?, error = 'player banned' WHERE status = 'queued' AND (mc_username_lower = ? OR discord_id = ?)",
      [now, mcUsername ? mcUsername.toLowerCase() : null, discordId]
    );
  });
  return { ok: true, mcUsername, discordId };
}

async function unbanPlayer(db, query) {
  const q = String(query || '').trim();
  const mention = /^<@!?(\d{15,22})>$/.exec(q);
  if (mention || /^\d{15,22}$/.test(q)) {
    return (await db.run('DELETE FROM bans WHERE discord_id = ?', [mention ? mention[1] : q])).changes;
  }
  if (!linking.isValidUsername(q)) return 0;
  const lower = q.toLowerCase();
  const rows = await db.all('SELECT * FROM bans WHERE mc_username_lower = ?', [lower]);
  const link = await linking.getActiveLinkByUsername(db, q);
  const discordIds = [...new Set([...rows.map((r) => r.discord_id), link && link.discord_id].filter(Boolean))];
  let n = (await db.run('DELETE FROM bans WHERE mc_username_lower = ?', [lower])).changes;
  for (const id of discordIds) n += (await db.run('DELETE FROM bans WHERE discord_id = ?', [id])).changes;
  return n;
}

const listBans = (db, limit = 25) => db.all('SELECT * FROM bans ORDER BY created_at DESC, id DESC LIMIT ?', [limit]);

module.exports = { findBan, banPlayer, unbanPlayer, listBans };
