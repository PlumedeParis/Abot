'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createQueue, recoverInterrupted, DeliveryError } = require('../src/queue');
const limits = require('../src/limits');
const { BACKENDS, testSettings, fakeLogger, MIN } = require('./helpers');

const S = testSettings();
const T0 = Date.UTC(2026, 0, 1);

function harness(db, { deliver, verify = async () => ({ ok: true }), clock = { t: T0 } } = {}) {
  const logger = fakeLogger();
  const notices = [];
  const deliveries = [];
  const q = createQueue({
    db,
    getSettings: () => S,
    logger,
    canRun: () => true,
    verify,
    deliver: async (req, ctx) => {
      deliveries.push(req.id);
      return deliver(req, ctx);
    },
    notify: async (req, msg) => notices.push({ player: req.mc_username, msg }),
    now: () => clock.t
  });
  return { q, logger, notices, deliveries, clock };
}

const enqueue = (db, discordId, now) => limits.reserve(db, { discordId, mcUsername: `P${discordId.slice(-3)}`, kit: 'totem', limits: S.limits, now });
const status = async (db, id) => (await db.get('SELECT status FROM requests WHERE id = ?', [id])).status;

for (const [name, open] of BACKENDS) {
  test(`[${name}] success is reported only after a confirmed delivery`, async () => {
    const db = await open();
    const { id } = (await enqueue(db, '400000000000000001', T0)).request;
    const h = harness(db, { deliver: async () => ({ outcome: 'delivered' }) });
    assert.equal(await h.q.processNext(), 'delivered');
    assert.equal(await status(db, id), 'delivered');
    assert.match(h.notices.at(-1).msg, /has been delivered/);
    await db.close();
  });

  test(`[${name}] a failure before handoff is never reported as delivered and is refunded`, async () => {
    const db = await open();
    const { id } = (await enqueue(db, '400000000000000002', T0)).request;
    const h = harness(db, {
      deliver: async (req, ctx) => {
        await ctx.setStage('retrieving');
        throw new DeliveryError('kit "totem" is out of stock', { playerMessage: 'Sorry, the totem kit is out of stock right now.' });
      }
    });
    assert.equal(await h.q.processNext(), 'failed');
    assert.equal(await status(db, id), 'failed');
    assert.ok(h.notices.every((n) => !/delivered/.test(n.msg)));
    assert.ok(h.logger.has('delivery.failed'));
    const u = await limits.usage(db, '400000000000000002', S.limits, T0 + 1000);
    assert.equal(u.quotaUsed, 0);
    assert.equal(u.cooldownRemainingMs, 0);
    await db.close();
  });

  test(`[${name}] a non-delivered result without an exception still fails`, async () => {
    const db = await open();
    const { id } = (await enqueue(db, '400000000000000003', T0)).request;
    const h = harness(db, { deliver: async () => ({ outcome: 'maybe' }) });
    assert.equal(await h.q.processNext(), 'failed');
    assert.equal(await status(db, id), 'failed');
    await db.close();
  });

  test(`[${name}] a failure after handoff is "unconfirmed", never "delivered"`, async () => {
    const db = await open();
    const { id } = (await enqueue(db, '400000000000000004', T0)).request;
    const h = harness(db, {
      deliver: async (req, ctx) => {
        await ctx.setStage('handoff');
        throw new DeliveryError('player did not pick up the kit in time');
      }
    });
    assert.equal(await h.q.processNext(), 'unconfirmed');
    assert.equal(await status(db, id), 'unconfirmed');
    assert.match(h.notices.at(-1).msg, /could not confirm/);
    await db.close();
  });

  test(`[${name}] retryable errors are retried up to maxAttempts`, async () => {
    const db = await open();
    const { id } = (await enqueue(db, '400000000000000005', T0)).request;
    const h = harness(db, {
      deliver: async () => {
        throw new DeliveryError('Minecraft connection lost', { retryable: true });
      }
    });
    assert.equal(await h.q.processNext(), 'retry');
    assert.equal(await status(db, id), 'queued');
    h.clock.t += MIN;
    assert.equal(await h.q.processNext(), 'failed');
    assert.equal(h.deliveries.length, 2);
    await db.close();
  });

  test(`[${name}] global limit: at most 2 deliveries start per minute`, async () => {
    const db = await open();
    for (const id of ['400000000000000011', '400000000000000012', '400000000000000013']) await enqueue(db, id, T0);
    const h = harness(db, { deliver: async () => ({ outcome: 'delivered' }) });
    assert.equal(await h.q.processNext(), 'delivered');
    h.clock.t += 1000;
    assert.equal(await h.q.processNext(), 'delivered');
    h.clock.t += 1000;
    const third = await h.q.processNext();
    assert.equal(third.waitUntil, T0 + 60000);
    assert.equal(h.deliveries.length, 2);
    h.clock.t = T0 + 60000;
    assert.equal(await h.q.processNext(), 'delivered');
    await db.close();
  });

  test(`[${name}] each request is delivered exactly once`, async () => {
    const db = await open();
    await enqueue(db, '400000000000000021', T0);
    const h = harness(db, {
      deliver: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { outcome: 'delivered' };
      }
    });
    const h2 = harness(db, { deliver: async () => ({ outcome: 'delivered' }), clock: h.clock });
    await Promise.all([h.q.processNext(), h2.q.processNext()]);
    assert.equal(h.deliveries.length + h2.deliveries.length, 1);
    await db.close();
  });

  test(`[${name}] verification failures drop the request; Discord outages keep it queued`, async () => {
    const db = await open();
    const { id } = (await enqueue(db, '400000000000000031', T0)).request;
    let mode = 'down';
    const h = harness(db, {
      deliver: async () => ({ outcome: 'delivered' }),
      verify: async () => (mode === 'down' ? { ok: false, retryLater: true, reason: 'Discord unavailable' } : { ok: false, reason: 'not a member', playerMessage: 'cancelled' })
    });
    const r = await h.q.processNext();
    assert.ok(r.waitUntil > T0);
    assert.equal(await status(db, id), 'queued');
    mode = 'gone';
    assert.equal(await h.q.processNext(), 'failed');
    assert.equal(h.deliveries.length, 0, 'never delivered to an unverified player');
    await db.close();
  });

  test(`[${name}] queued requests expire after maxQueueWaitMinutes`, async () => {
    const db = await open();
    const { id } = (await enqueue(db, '400000000000000041', T0)).request;
    const h = harness(db, { deliver: async () => ({ outcome: 'delivered' }) });
    h.clock.t = T0 + 31 * MIN;
    assert.equal(await h.q.processNext(), null);
    assert.equal(await status(db, id), 'expired');
    await db.close();
  });

  test(`[${name}] restart recovery: re-queue before handoff, unconfirmed after`, async () => {
    const db = await open();
    const ins = (d, stage, attempts) =>
      db.get("INSERT INTO requests (discord_id, mc_username, mc_username_lower, kit, status, stage, attempts, created_at, started_at) VALUES (?, 'x', 'x', 'pvp', 'processing', ?, ?, ?, ?) RETURNING id", [
        d,
        stage,
        attempts,
        T0,
        T0
      ]);
    const a = await ins('400000000000000051', 'navigating', 1);
    const b = await ins('400000000000000052', 'handoff', 1);
    const c = await ins('400000000000000053', 'retrieving', 2);
    await recoverInterrupted(db, { maxAttempts: 2, logger: fakeLogger(), now: T0 + 1000 });
    assert.equal(await status(db, a.id), 'queued');
    assert.equal(await status(db, b.id), 'unconfirmed');
    assert.equal(await status(db, c.id), 'failed');
    await db.close();
  });
}
