'use strict';

// Kits left in each chest, counted every time the bot opens it. One alert
// when a chest gets low, one when it is empty and one when it is restocked.

const { getSetting, setSetting } = require('./db');

const readStock = (db) => getSetting(db, 'stock', {});

async function recordStock(db, logger, { kit, left, lowThreshold, now = Date.now() }) {
  const stock = await readStock(db);
  const prev = stock[kit]?.left;
  stock[kit] = { left, checkedAt: now };
  await setSetting(db, 'stock', stock);
  const wasLow = prev !== undefined && prev <= lowThreshold;
  if (left === 0 && prev !== 0) await logger.warn('stock.empty', `📦 The ${kit} chest is EMPTY. Restock it: ${kit} orders fail until then (they do not count for players).`);
  else if (left > 0 && left <= lowThreshold && (!wasLow || prev === 0)) await logger.warn('stock.low', `⚠️ Only ${left} ${kit} kit(s) left in the chest.`);
  else if (left > lowThreshold && wasLow) await logger.info('stock.restocked', `✅ The ${kit} chest was restocked (${left} kits).`);
}

module.exports = { readStock, recordStock };
