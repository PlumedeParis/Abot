'use strict';

// Players banned from the kit bot. Banning a linked Minecraft name also bans
// its Discord account, so linking another account does not get around it.

const linking = require('./linking');

// "<minecraft name>", "<@mention>" or a Discord ID -> { name } | { discordId } | null
function parseTarget(query) {
  const q = String(query || '').trim();
  const mention = /^<@!?(\d{15,22})>$/.exec(q);
  if (mention) return { discordId: mention[1] };
  if (/^\d{15,22}$/.test(q)) return { discordId: q };
  if (linking.isValidUsername(q)) return { name: q };
  return null;
}

function findBan(db, { name = null, discordId = null }) {
  if (!name && !discordId) return Promise.resolve(null);
  return db.get('SELECT * FROM bans WHERE (mc_username_lower IS NOT NULL AND mc_username_lower = ?) OR (discord_id IS NOT NULL AND discord_id = ?) LIMIT 1', [
    name ? name.toLowerCase() : null,
    discordId
  ]);
}

async function ban(db, { query, reason = null, by, now = Date.now() }) {
  const t = parseTarget(query);
  if (!t) return { ok: false, reason: 'invalid' };
  const name = t.name || null;
  let discordId = t.discordId || null;
  if (name) discordId = (await linking.activeLinkByUsername(db, name))?.discord_id || null;
  if (await findBan(db, { name, discordId })) return { ok: false, reason: 'already_banned' };
  await db.transaction(async (tx) => {
    await tx.run('INSERT INTO bans (mc_username_lower, mc_username, discord_id, reason, banned_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      name ? name.toLowerCase() : null,
      name,
      discordId,
      reason,
      by,
      now
    ]);
    if (discordId) await tx.run('UPDATE link_codes SET used_at = ? WHERE discord_id = ? AND used_at IS NULL', [now, discordId]);
    await tx.run("UPDATE requests SET status = 'cancelled', completed_at = ?, error = 'player banned' WHERE status = 'queued' AND (mc_username_lower = ? OR discord_id = ?)", [
      now,
      name ? name.toLowerCase() : null,
      discordId
    ]);
  });
  return { ok: true, name, discordId };
}

async function unban(db, query) {
  const t = parseTarget(query);
  if (!t) return 0;
  if (t.discordId) return (await db.run('DELETE FROM bans WHERE discord_id = ?', [t.discordId])).changes;
  const lower = t.name.toLowerCase();
  const ids = new Set((await db.all('SELECT discord_id FROM bans WHERE mc_username_lower = ? AND discord_id IS NOT NULL', [lower])).map((r) => r.discord_id));
  const link = await linking.activeLinkByUsername(db, t.name);
  if (link) ids.add(link.discord_id);
  let n = (await db.run('DELETE FROM bans WHERE mc_username_lower = ?', [lower])).changes;
  for (const id of ids) n += (await db.run('DELETE FROM bans WHERE discord_id = ?', [id])).changes;
  return n;
}

const listBans = (db, limit = 25) => db.all('SELECT * FROM bans ORDER BY created_at DESC, id DESC LIMIT ?', [limit]);

module.exports = { parseTarget, findBan, ban, unban, listBans };
