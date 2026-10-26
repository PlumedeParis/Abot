'use strict';

// Delivery queue stored in the "requests" table.
//   queued -> processing -> delivered | unconfirmed | failed
//   queued -> cancelled | expired | failed
// One delivery at a time (one inventory). A request is claimed with a
// conditional UPDATE, so it is never processed twice. "delivered" is written
// only after the player was seen picking the kit up; a failure after the kit
// left the bot ("handoff" stage) is "unconfirmed", never a success.

const { nextGlobalSlot } = require('./limits');

class DeliveryError extends Error {
  constructor(message, { retryable = false, playerMessage } = {}) {
    super(message);
    this.name = 'DeliveryError';
    this.retryable = retryable;
    this.playerMessage = playerMessage;
  }
}

// After a restart: requests interrupted mid-delivery.
async function recoverInterrupted(db, { maxAttempts, logger, now = Date.now() }) {
  for (const r of await db.all("SELECT * FROM requests WHERE status = 'processing'")) {
    if (r.stage === 'handoff') {
      await db.run("UPDATE requests SET status = 'unconfirmed', completed_at = ?, error = 'interrupted after the kit was handed off' WHERE id = ?", [now, r.id]);
      await logger.warn('delivery.unconfirmed', `Request #${r.id} (${r.kit} for ${r.mc_username}) was interrupted after the handoff; marked unconfirmed.`);
    } else if (Number(r.attempts) < maxAttempts) {
      await db.run("UPDATE requests SET status = 'queued', stage = NULL WHERE id = ?", [r.id]);
      await logger.info('queue.recovered', `Request #${r.id} (${r.kit} for ${r.mc_username}) was interrupted before the handoff; queued again.`);
    } else {
      await db.run("UPDATE requests SET status = 'failed', completed_at = ?, error = 'interrupted; no attempts left' WHERE id = ?", [now, r.id]);
      await logger.warn('delivery.failed', `Request #${r.id} (${r.kit} for ${r.mc_username}) failed after an interruption; it does not count.`);
    }
  }
}

function createQueue({ db, getSettings, logger, canRun, verify, deliver, notify, now = () => Date.now() }) {
  let stopped = true;
  let current = null;
  let wake = null;
  let loop = null;

  const finish = (id, status, error = null) =>
    db.run("UPDATE requests SET status = ?, completed_at = ?, error = ? WHERE id = ? AND status IN ('queued', 'processing')", [status, now(), error, id]);

  async function expireStale() {
    const cutoff = now() - getSettings().limits.maxQueueWaitMinutes * 60000;
    for (const r of await db.all("SELECT * FROM requests WHERE status = 'queued' AND created_at < ?", [cutoff])) {
      await finish(r.id, 'expired', 'waited too long in the queue');
      await logger.warn('queue.expired', `Request #${r.id} (${r.kit} for ${r.mc_username}) expired in the queue; it does not count.`);
      await notify(r, 'Your kit request expired before it could be delivered. It does not count against your limits.');
    }
  }

  // Handles at most one request. Returns its outcome, { waitUntil } or null when idle.
  async function processNext() {
    if (!canRun()) return null;
    const s = getSettings();
    await expireStale();
    const req = await db.get("SELECT * FROM requests WHERE status = 'queued' ORDER BY created_at, id LIMIT 1");
    if (!req) return null;
    const slot = await nextGlobalSlot(db, s.limits.globalPerMinute, now());
    if (slot > now()) return { waitUntil: slot };

    const check = await verify(req);
    if (!check.ok && check.retryLater) return { waitUntil: now() + 15000 };
    if (!check.ok) {
      await finish(req.id, 'failed', check.reason);
      await logger.warn('delivery.dropped', `Request #${req.id} (${req.kit} for ${req.mc_username}) dropped before delivery: ${check.reason}. It does not count.`);
      if (check.playerMessage) await notify(req, check.playerMessage);
      return 'failed';
    }

    const claimed = await db.run("UPDATE requests SET status = 'processing', stage = 'starting', started_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'queued'", [now(), req.id]);
    if (claimed.changes !== 1) return null;
    current = req;
    let stage = 'starting';
    await logger.info('delivery.start', `Delivering a ${req.kit} kit to ${req.mc_username} (request #${req.id}).`);
    try {
      const setStage = async (st) => {
        stage = st;
        await db.run("UPDATE requests SET stage = ? WHERE id = ? AND status = 'processing'", [st, req.id]);
      };
      await deliver(req, { setStage });
      await finish(req.id, 'delivered');
      await logger.info('delivery.done', `Delivered a ${req.kit} kit to ${req.mc_username} (request #${req.id}).`);
      await notify(req, `Your ${req.kit} kit has been delivered. Enjoy!`);
      return 'delivered';
    } catch (e) {
      const msg = e?.message || String(e);
      if (stage === 'handoff') {
        await finish(req.id, 'unconfirmed', msg);
        await logger.error('delivery.unconfirmed', `Could not confirm that ${req.mc_username} picked up the ${req.kit} kit (request #${req.id}): ${msg}`);
        await notify(req, 'I dropped your kit but could not confirm that you picked it up. Contact staff if you did not get it.');
        return 'unconfirmed';
      }
      if (e instanceof DeliveryError && e.retryable && Number(req.attempts) + 1 < s.limits.maxAttempts) {
        await db.run("UPDATE requests SET status = 'queued', stage = NULL, error = ? WHERE id = ? AND status = 'processing'", [msg, req.id]);
        await logger.warn('delivery.retry', `Delivery #${req.id} (${req.kit} for ${req.mc_username}) failed and will be retried: ${msg}`);
        return 'retry';
      }
      await finish(req.id, 'failed', msg);
      await logger.error('delivery.failed', `Delivery #${req.id} (${req.kit} for ${req.mc_username}) failed: ${msg}. It does not count.`);
      if (e?.playerMessage !== null) await notify(req, e?.playerMessage || 'Sorry, your kit could not be delivered. It does not count against your limits.');
      return 'failed';
    } finally {
      current = null;
    }
  }

  async function run() {
    while (!stopped) {
      let waitMs = 1000;
      try {
        const r = await processNext();
        if (r?.waitUntil) waitMs = Math.max(250, Math.min(r.waitUntil - now(), 10000));
        else if (r) waitMs = 250;
      } catch (e) {
        await logger.error('queue.error', `Queue error: ${e.message}`);
        waitMs = 5000;
      }
      if (stopped) break;
      await new Promise((resolve) => {
        const t = setTimeout(resolve, waitMs);
        wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
      wake = null;
    }
  }

  return {
    processNext,
    current: () => current,
    poke: () => wake && wake(),
    start() {
      if (!stopped) return;
      stopped = false;
      loop = run();
    },
    async stop() {
      stopped = true;
      if (wake) wake();
      await loop;
    }
  };
}

const queueSnapshot = (db, limit = 20) => db.all("SELECT * FROM requests WHERE status IN ('queued', 'processing') ORDER BY created_at, id LIMIT ?", [limit]);

async function globalStats(db) {
  const counts = Object.fromEntries((await db.all('SELECT status, COUNT(*) AS n FROM requests GROUP BY status')).map((r) => [r.status, Number(r.n)]));
  const byKit = (await db.all('SELECT kit, COUNT(*) AS n FROM requests GROUP BY kit ORDER BY n DESC')).map((r) => ({ kit: r.kit, n: Number(r.n) }));
  return { total: Object.values(counts).reduce((a, b) => a + b, 0), counts, byKit };
}

async function playerStats(db, discordId) {
  const rows = await db.all('SELECT status, COUNT(*) AS n FROM requests WHERE discord_id = ? GROUP BY status', [discordId]);
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
}

module.exports = { DeliveryError, recoverInterrupted, createQueue, queueSnapshot, globalStats, playerStats };
