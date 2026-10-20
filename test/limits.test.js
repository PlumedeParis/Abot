'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const limits = require('../src/limits');
const { BACKENDS, testSettings, MIN, HOUR } = require('./helpers');

const L = testSettings().limits;
const T0 = Date.UTC(2026, 0, 1);
const finish = (db, id, status, at) => db.run('UPDATE requests SET status = ?, completed_at = ? WHERE id = ?', [status, at, id]);
const reserve = (db, discordId, kit, now, lim = L) => limits.reserve(db, { discordId, mcUsername: `P${discordId.slice(-4)}`, kit, limits: lim, now });

for (const [name, open] of BACKENDS) {
  test(`[${name}] cooldown is shared across all kits`, async () => {
    const db = await open();
    const a = await reserve(db, '100000000000000001', 'totem', T0);
    assert.equal(a.ok, true);
    await finish(db, a.request.id, 'delivered', T0 + 1000);

    for (const kit of ['totem', 'pvp', 'grief']) {
      const r = await reserve(db, '100000000000000001', kit, T0 + 5 * MIN);
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cooldown');
      assert.equal(r.retryAt, T0 + 10 * MIN);
    }
    assert.equal((await reserve(db, '100000000000000001', 'pvp', T0 + 10 * MIN)).ok, true);
    await db.close();
  });

  test(`[${name}] only one pending request per player`, async () => {
    const db = await open();
    assert.equal((await reserve(db, '100000000000000002', 'totem', T0)).ok, true);
    const r = await reserve(db, '100000000000000002', 'grief', T0 + 11 * MIN);
    assert.equal(r.reason, 'pending');
    await db.close();
  });

  test(`[${name}] concurrent requests from one player create a single request`, async () => {
    const db = await open();
    const results = await Promise.all(Array.from({ length: 5 }, () => reserve(db, '100000000000000003', 'totem', T0)));
    assert.equal(results.filter((r) => r.ok).length, 1);
    const n = await db.get("SELECT COUNT(*) AS n FROM requests WHERE discord_id = '100000000000000003'");
    assert.equal(Number(n.n), 1);
    await db.close();
  });

  test(`[${name}] failed deliveries are refunded (no cooldown, no quota)`, async () => {
    const db = await open();
    const a = await reserve(db, '100000000000000004', 'totem', T0);
    await finish(db, a.request.id, 'failed', T0 + 1000);
    const b = await reserve(db, '100000000000000004', 'pvp', T0 + 2000);
    assert.equal(b.ok, true, 'a failed request must not start the cooldown');
    assert.equal(b.usage.quotaUsed, 0);
    await db.close();
  });

  test(`[${name}] unconfirmed handoffs count against the limits`, async () => {
    const db = await open();
    const a = await reserve(db, '100000000000000005', 'totem', T0);
    await finish(db, a.request.id, 'unconfirmed', T0 + 1000);
    assert.equal((await reserve(db, '100000000000000005', 'totem', T0 + 2000)).reason, 'cooldown');
    await db.close();
  });

  test(`[${name}] rolling 24h quota of 10 kits`, async () => {
    const db = await open();
    const id = '100000000000000006';
    let t = T0;
    for (let i = 0; i < 10; i++) {
      const r = await reserve(db, id, ['totem', 'pvp', 'grief'][i % 3], t);
      assert.equal(r.ok, true, `request ${i + 1} should be accepted`);
      await finish(db, r.request.id, 'delivered', t + 1000);
      t += 11 * MIN;
    }
    const over = await reserve(db, id, 'totem', t);
    assert.equal(over.reason, 'quota');
    assert.equal(over.retryAt, T0 + 24 * HOUR, 'quota frees when the oldest request leaves the window');
    assert.equal((await reserve(db, id, 'totem', T0 + 24 * HOUR - 1)).reason, 'quota');
    assert.equal((await reserve(db, id, 'totem', T0 + 24 * HOUR + 1)).ok, true);
    await db.close();
  });

  test(`[${name}] admin cooldown and quota resets`, async () => {
    const db = await open();
    const id = '100000000000000007';
    const small = { ...L, dailyQuota: 1 };
    const a = await reserve(db, id, 'totem', T0, small);
    await finish(db, a.request.id, 'delivered', T0 + 1000);
    assert.equal((await reserve(db, id, 'totem', T0 + MIN, small)).reason, 'cooldown');
    await limits.resetCooldown(db, id, T0 + 2 * MIN);
    assert.equal((await reserve(db, id, 'totem', T0 + 3 * MIN, small)).reason, 'quota');
    await limits.resetQuota(db, id, T0 + 4 * MIN);
    assert.equal((await reserve(db, id, 'totem', T0 + 5 * MIN, small)).ok, true);
    await db.close();
  });

  test(`[${name}] global rate limit of 2 deliveries per minute`, async () => {
    const db = await open();
    assert.equal(await limits.nextGlobalSlot(db, 2, T0), T0);
    await db.run("INSERT INTO requests (discord_id, mc_username, mc_username_lower, kit, status, created_at, started_at) VALUES ('1', 'a', 'a', 'totem', 'delivered', ?, ?)", [T0, T0]);
    assert.equal(await limits.nextGlobalSlot(db, 2, T0 + 1000), T0 + 1000);
    await db.run("INSERT INTO requests (discord_id, mc_username, mc_username_lower, kit, status, created_at, started_at) VALUES ('2', 'b', 'b', 'totem', 'delivered', ?, ?)", [T0, T0 + 20000]);
    assert.equal(await limits.nextGlobalSlot(db, 2, T0 + 30000), T0 + 60000);
    assert.equal(await limits.nextGlobalSlot(db, 2, T0 + 60001), T0 + 60001);
    await db.close();
  });

  test(`[${name}] queue size limit`, async () => {
    const db = await open();
    const small = { ...L, maxQueueSize: 2 };
    assert.equal((await reserve(db, '100000000000000010', 'totem', T0, small)).ok, true);
    assert.equal((await reserve(db, '100000000000000011', 'totem', T0, small)).position, 2);
    assert.equal((await reserve(db, '100000000000000012', 'totem', T0, small)).reason, 'queue_full');
    await db.close();
  });

  test(`[${name}] limits survive a restart`, async () => {
    // Re-open the same SQLite file to simulate a restart.
    if (!name.startsWith('sqlite')) return;
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const { openDatabase } = require('../src/database');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kitbot-'));
    const file = path.join(dir, 'k.db');
    let db = await openDatabase({ sqlitePath: file });
    const a = await reserve(db, '100000000000000013', 'totem', T0);
    await finish(db, a.request.id, 'delivered', T0 + 1000);
    await db.close();
    db = await openDatabase({ sqlitePath: file });
    assert.equal((await reserve(db, '100000000000000013', 'pvp', T0 + MIN)).reason, 'cooldown');
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test('formatDuration', () => {
  assert.equal(limits.formatDuration(5 * MIN + 3000), '5m 3s');
  assert.equal(limits.formatDuration(2 * HOUR + 5 * MIN), '2h 5m');
  assert.equal(limits.formatDuration(10), '1s');
});
