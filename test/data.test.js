'use strict';

// Linking, limits, bans, stock and the queue, on SQLite and on PostgreSQL (PGlite).

const test = require('node:test');
const assert = require('node:assert/strict');
const linking = require('../src/linking');
const limits = require('../src/limits');
const bans = require('../src/bans');
const { recordStock, readStock } = require('../src/stock');
const { createQueue, recoverInterrupted, DeliveryError } = require('../src/queue');
const { settings, sqliteDb, pgliteDb, fakeLogger, member } = require('./helpers');

const A = '111111111111111111';
const B = '222222222222222222';
const DAY = 86400000;

for (const [label, open] of [
  ['sqlite', sqliteDb],
  ['postgres', pgliteDb]
]) {
  test(`${label}: linking, name changes and their cooldown`, async () => {
    const db = await open();
    const s = settings();
    let now = 1_000_000_000_000;
    const link = async (discordId, name, opts = {}) => {
      const r = await linking.startLink(db, { discordId, name, settings: s, now, ...opts });
      if (!r.ok) return r;
      return linking.completeLink(db, { name, code: r.code, settings: s, checkMembership: member, now });
    };
    assert.equal((await link(A, 'Steve')).ok, true);
    assert.equal((await link(B, 'Steve')).reason, 'taken');
    assert.equal((await link(A, 'Steve')).reason, 'already_linked');
    assert.equal((await link(A, 'Alex')).reason, 'change_too_soon');
    now += 31 * DAY;
    const changed = await link(A, 'Alex');
    assert.equal(changed.mode, 'change');
    assert.equal(changed.previous, 'Steve');
    // Unlinking does not reset the cooldown.
    await linking.revokeLinks(db, A, 'test');
    assert.equal((await link(A, 'Notch')).reason, 'change_too_soon');

    // Codes: wrong name, expiry, single use, too many attempts.
    const r = await linking.startLink(db, { discordId: B, name: 'Bob', settings: s, now });
    assert.equal((await linking.completeLink(db, { name: 'Mallory', code: r.code, settings: s, checkMembership: member, now })).reason, 'invalid_code');
    assert.equal((await linking.completeLink(db, { name: 'Bob', code: r.code, settings: s, checkMembership: member, now: now + 11 * 60000 })).reason, 'expired_code');
    for (let i = 0; i < 5; i++) await linking.completeLink(db, { name: 'Eve', code: 'AAAA-AAAA', settings: s, checkMembership: member, now });
    assert.equal((await linking.completeLink(db, { name: 'Eve', code: 'AAAA-AAAA', settings: s, checkMembership: member, now })).reason, 'too_many_attempts');
    await db.close();
  });

  test(`${label}: cooldown, quota, refunds and the global rate`, async () => {
    const db = await open();
    const l = { ...settings().limits, cooldownMinutes: 10, dailyQuota: 2 };
    let now = 2_000_000_000_000;
    const order = () => limits.reserve(db, { discordId: A, name: 'Steve', kit: 'pvp', limits: l, now });
    const first = await order();
    assert.equal(first.ok, true);
    assert.equal((await order()).reason, 'pending');
    await db.run("UPDATE requests SET status = 'delivered'");
    now += 60000;
    assert.equal((await order()).reason, 'cooldown');
    now += 10 * 60000;
    assert.equal((await order()).ok, true);
    await db.run("UPDATE requests SET status = 'delivered'");
    now += 11 * 60000;
    const q = await order();
    assert.equal(q.reason, 'quota');
    assert.equal(q.retryAt, first.request.created_at + DAY);
    // Failed orders are refunded.
    await db.run("UPDATE requests SET status = 'failed'");
    assert.equal((await order()).ok, true);
    await limits.resetCooldown(db, A, now);
    assert.equal((await limits.usage(db, A, l, now)).cooldownRemainingMs, 0);

    await db.run('UPDATE requests SET started_at = ?', [now]);
    assert.equal(await limits.nextGlobalSlot(db, 5, now), now);
    assert.equal(await limits.nextGlobalSlot(db, 1, now), now + 60000);
    assert.equal(limits.formatDuration(65000), '1m 5s');
    await db.close();
  });

  test(`${label}: bans and stock alerts`, async () => {
    const db = await open();
    const s = settings();
    const r = await linking.startLink(db, { discordId: A, name: 'Steve', settings: s });
    await linking.completeLink(db, { name: 'Steve', code: r.code, settings: s, checkMembership: member });
    const b = await bans.ban(db, { query: 'Steve', reason: 'grief', by: 'admin' });
    assert.deepEqual([b.ok, b.discordId], [true, A]);
    assert.ok(await bans.findBan(db, { discordId: A }), 'the Discord account is banned too');
    assert.equal((await bans.ban(db, { query: `<@${A}>`, by: 'admin' })).reason, 'already_banned');
    assert.ok((await bans.unban(db, 'Steve')) >= 1);
    assert.equal(await bans.findBan(db, { name: 'Steve', discordId: A }), undefined);
    assert.equal((await bans.ban(db, { query: 'not a name!', by: 'x' })).reason, 'invalid');

    const logger = fakeLogger();
    for (const left of [9, 5, 4, 0, 0, 12]) await recordStock(db, logger, { kit: 'pvp', left, lowThreshold: 5 });
    assert.deepEqual(
      logger.events.map((e) => e.type),
      ['stock.low', 'stock.empty', 'stock.restocked']
    );
    assert.equal((await readStock(db)).pvp.left, 12);
    await db.close();
  });
}

test('queue: delivered, failed with a refund, unconfirmed after the handoff, retry', async () => {
  const db = await sqliteDb();
  const logger = fakeLogger();
  const notes = [];
  let behaviour = async () => {};
  const s = settings({ limits: { globalPerMinute: 100 } });
  const queue = createQueue({
    db,
    getSettings: () => s,
    logger,
    canRun: () => true,
    verify: async () => ({ ok: true }),
    deliver: (req, ctx) => behaviour(req, ctx),
    notify: async (req, msg) => void notes.push(msg)
  });
  const add = (discordId) => limits.reserve(db, { discordId, name: `P${discordId.slice(0, 3)}`, kit: 'pvp', limits: { ...s.limits, cooldownMinutes: 0.0001 } });
  const status = async (id) => (await db.get('SELECT status FROM requests WHERE id = ?', [id])).status;

  let r = await add(A);
  assert.equal(await queue.processNext(), 'delivered');
  assert.equal(await status(r.request.id), 'delivered');

  behaviour = async () => {
    throw new DeliveryError('chest empty', { playerMessage: 'out of stock' });
  };
  r = await add(B);
  assert.equal(await queue.processNext(), 'failed');
  assert.equal(notes.at(-1), 'out of stock');

  behaviour = async (req, ctx) => {
    await ctx.setStage('handoff');
    throw new DeliveryError('not picked up');
  };
  r = await add('333333333333333333');
  assert.equal(await queue.processNext(), 'unconfirmed');

  behaviour = async () => {
    throw new DeliveryError('connection lost', { retryable: true });
  };
  r = await add('444444444444444444');
  assert.equal(await queue.processNext(), 'retry');
  assert.equal(await status(r.request.id), 'queued');

  // A restart in the middle of a delivery.
  await db.run("UPDATE requests SET status = 'processing', stage = 'handoff' WHERE id = ?", [r.request.id]);
  await recoverInterrupted(db, { maxAttempts: 2, logger });
  assert.equal(await status(r.request.id), 'unconfirmed');
  assert.equal(await queue.processNext(), null, 'nothing left');
});
