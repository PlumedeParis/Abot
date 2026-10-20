'use strict';

// Persistent delivery queue.
//
// Request lifecycle (stored in the "requests" table):
//   queued -> processing -> delivered | unconfirmed | failed
//   queued -> cancelled (link revoked) | expired (waited too long) | failed (pre-checks)
//
// Guarantees:
//  - A request is claimed with a conditional UPDATE, so it can only be
//    processed once even if two workers ever run.
//  - Deliveries run one at a time (the bot has a single inventory).
//  - No more than globalPerMinute deliveries start in any 60 seconds.
//  - "delivered" is written ONLY when the deliverer reports a confirmed
//    pickup. Any failure after the items left the bot ("handoff" stage) is
//    "unconfirmed" and is never reported to the player as a success.
//  - After a restart, requests that were mid-delivery are re-queued when the
//    kit never left the bot, or marked unconfirmed otherwise.

const { nextGlobalSlot } = require('./limits');

const HANDOFF_STAGES = ['handoff'];

class DeliveryError extends Error {
  constructor(message, { retryable = false, playerMessage = null } = {}) {
    super(message);
    this.name = 'DeliveryError';
    this.retryable = retryable;
    this.playerMessage = playerMessage;
  }
}

async function recoverInterrupted(db, { maxAttempts, logger, now = Date.now() }) {
  const rows = await db.all("SELECT * FROM requests WHERE status = 'processing'");
  for (const r of rows) {
    if (HANDOFF_STAGES.includes(r.stage)) {
      await db.run("UPDATE requests SET status = 'unconfirmed', completed_at = ?, error = ? WHERE id = ? AND status = 'processing'", [
        now,
        'interrupted after the kit was handed off',
        r.id
      ]);
      await logger.warn('delivery.unconfirmed', `Request #${r.id} (${r.kit} for ${r.mc_username}) was interrupted after handoff; marked unconfirmed.`);
    } else if (Number(r.attempts) < maxAttempts) {
      await db.run("UPDATE requests SET status = 'queued', stage = NULL WHERE id = ? AND status = 'processing'", [r.id]);
      await logger.info('queue.recovered', `Request #${r.id} (${r.kit} for ${r.mc_username}) was interrupted before handoff; re-queued.`);
    } else {
      await db.run("UPDATE requests SET status = 'failed', completed_at = ?, error = ? WHERE id = ? AND status = 'processing'", [
        now,
        'interrupted; attempts exhausted',
        r.id
      ]);
      await logger.warn('delivery.failed', `Request #${r.id} (${r.kit} for ${r.mc_username}) failed after an interruption; quota refunded.`);
    }
  }
  return rows.length;
}

function createQueue({ db, getSettings, logger, deliver, canRun, verify, notify, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let running = false;
  let stopped = false;
  let current = null;
  let wake = null;
  let loopPromise = null;

  const setStage = (id, stage) => db.run("UPDATE requests SET stage = ? WHERE id = ? AND status = 'processing'", [stage, id]);

  async function finish(req, status, error = null) {
    await db.run("UPDATE requests SET status = ?, completed_at = ?, error = ? WHERE id = ? AND status IN ('queued', 'processing')", [
      status,
      now(),
      error,
      req.id
    ]);
  }

  async function expireStale() {
    const s = getSettings();
    const cutoff = now() - s.limits.maxQueueWaitMinutes * 60000;
    const stale = await db.all("SELECT * FROM requests WHERE status = 'queued' AND created_at < ?", [cutoff]);
    for (const r of stale) {
      await finish(r, 'expired', 'waited too long in the queue');
      await logger.warn('queue.expired', `Request #${r.id} (${r.kit} for ${r.mc_username}) expired in the queue; quota refunded.`);
      await notify(r, 'Your kit request expired before it could be delivered. It did not count against your limits.');
    }
  }

  // Processes at most one request. Returns the final status, or null if idle.
  async function processNext() {
    const s = getSettings();
    if (!canRun()) return null;
    await expireStale();
    const req = await db.get("SELECT * FROM requests WHERE status = 'queued' ORDER BY created_at ASC, id ASC LIMIT 1");
    if (!req) return null;

    const slot = await nextGlobalSlot(db, s.limits.globalPerMinute, now());
    if (slot > now()) return { waitUntil: slot };

    const check = await verify(req);
    if (!check.ok && check.retryLater) {
      // e.g. Discord temporarily unreachable: keep the request queued, never deliver unverified.
      await logger.debug('delivery.waiting', `Request #${req.id} is waiting: ${check.reason}`);
      return { waitUntil: now() + 15000 };
    }
    if (!check.ok) {
      await finish(req, 'failed', check.reason);
      await logger.warn('delivery.rejected', `Request #${req.id} (${req.kit} for ${req.mc_username}) dropped before delivery: ${check.reason}. Quota refunded.`);
      if (check.playerMessage) await notify(req, check.playerMessage);
      return 'failed';
    }

    const claimed = await db.run("UPDATE requests SET status = 'processing', stage = 'starting', started_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'queued'", [
      now(),
      req.id
    ]);
    if (claimed.changes !== 1) return null; // somebody else took it

    current = { ...req, status: 'processing' };
    let stage = 'starting';
    await logger.info('delivery.start', `Delivering ${req.kit} kit to ${req.mc_username} (request #${req.id}).`);
    try {
      const result = await deliver(req, {
        setStage: async (st) => {
          stage = st;
          await setStage(req.id, st);
        }
      });
      if (result && result.outcome === 'delivered') {
        await finish(req, 'delivered');
        await logger.info('delivery.complete', `Delivered ${req.kit} kit to ${req.mc_username} (request #${req.id}).`);
        await notify(req, `Your ${req.kit} kit has been delivered. Enjoy!`);
        return 'delivered';
      }
      // Anything else is treated as not delivered.
      throw new DeliveryError(result?.error || 'delivery did not confirm pickup', { playerMessage: result?.playerMessage });
    } catch (e) {
      const handedOff = HANDOFF_STAGES.includes(stage);
      const msg = e?.message || String(e);
      if (handedOff) {
        await finish(req, 'unconfirmed', msg);
        await logger.error('delivery.unconfirmed', `Could not confirm delivery of ${req.kit} kit to ${req.mc_username} (request #${req.id}): ${msg}`);
        await notify(req, 'I dropped your kit but could not confirm that you picked it up. Contact a staff member if you did not receive it.');
        return 'unconfirmed';
      }
      const attempts = Number(req.attempts) + 1;
      if (e instanceof DeliveryError && e.retryable && attempts < s.limits.maxAttempts) {
        await db.run("UPDATE requests SET status = 'queued', stage = NULL, error = ? WHERE id = ? AND status = 'processing'", [msg, req.id]);
        await logger.warn('delivery.retry', `Delivery of ${req.kit} kit to ${req.mc_username} (request #${req.id}) failed and will be retried: ${msg}`);
        return 'retry';
      }
      await finish(req, 'failed', msg);
      await logger.error('delivery.failed', `Delivery of ${req.kit} kit to ${req.mc_username} failed (request #${req.id}): ${msg}. Quota refunded.`);
      await notify(req, e?.playerMessage || 'Sorry, your kit could not be delivered. It did not count against your limits.');
      return 'failed';
    } finally {
      current = null;
    }
  }

  async function loop() {
    while (!stopped) {
      let waitMs = 1000;
      try {
        const r = await processNext();
        if (r && r.waitUntil) waitMs = Math.max(250, Math.min(r.waitUntil - now(), 10000));
        else if (r) waitMs = 250;
      } catch (e) {
        await logger.error('queue.error', `Queue worker error: ${e.message}`);
        waitMs = 5000;
      }
      if (stopped) break;
      await Promise.race([sleep(waitMs), new Promise((r) => (wake = r))]);
      wake = null;
    }
  }

  return {
    processNext,
    start() {
      if (running) return;
      running = true;
      stopped = false;
      loopPromise = loop();
    },
    poke() {
      if (wake) wake();
    },
    async stop() {
      stopped = true;
      if (wake) wake();
      await loopPromise;
      running = false;
    },
    current: () => current
  };
}

async function queueSnapshot(db, limit = 20) {
  return db.all("SELECT * FROM requests WHERE status IN ('queued', 'processing') ORDER BY created_at ASC, id ASC LIMIT ?", [limit]);
}

async function globalStats(db) {
  const byStatus = await db.all('SELECT status, COUNT(*) AS n FROM requests GROUP BY status');
  const byKit = await db.all("SELECT kit, COUNT(*) AS n FROM requests WHERE status = 'delivered' GROUP BY kit ORDER BY n DESC");
  const requested = await db.all('SELECT kit, COUNT(*) AS n FROM requests GROUP BY kit ORDER BY n DESC');
  const counts = Object.fromEntries(byStatus.map((r) => [r.status, Number(r.n)]));
  return {
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    counts,
    deliveredByKit: byKit.map((r) => ({ kit: r.kit, n: Number(r.n) })),
    requestedByKit: requested.map((r) => ({ kit: r.kit, n: Number(r.n) }))
  };
}

async function playerStats(db, discordId) {
  const rows = await db.all('SELECT status, COUNT(*) AS n FROM requests WHERE discord_id = ? GROUP BY status', [discordId]);
  const last = await db.get('SELECT * FROM requests WHERE discord_id = ? ORDER BY created_at DESC LIMIT 1', [discordId]);
  return { counts: Object.fromEntries(rows.map((r) => [r.status, Number(r.n)])), last };
}

module.exports = { createQueue, recoverInterrupted, queueSnapshot, globalStats, playerStats, DeliveryError, HANDOFF_STAGES };
