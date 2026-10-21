'use strict';

// Kit stock, counted by the Minecraft bot each time it opens a kit chest and
// stored in the shared settings so /kitbot stock can show it. An alert is
// posted when a chest goes down to the low threshold, when it is empty, and
// when it has been restocked above the threshold: once per change, not on
// every delivery.

const { getSetting, setSetting } = require('./database');

async function readStock(db) {
  return getSetting(db, 'stock', {});
}

async function recordStock(db, logger, { kit, left, lowThreshold, now = Date.now() }) {
  const stock = await readStock(db);
  const prev = stock[kit] ? stock[kit].left : undefined;
  stock[kit] = { left, checkedAt: now };
  await setSetting(db, 'stock', stock);

  const wasLow = prev !== undefined && prev <= lowThreshold;
  if (left === 0 && prev !== 0) {
    await logger.warn('stock.empty', `📦 The ${kit} chest is EMPTY: restock it. Orders for ${kit} kits fail until then (they do not count for players).`);
  } else if (left > 0 && left <= lowThreshold && (!wasLow || prev === 0)) {
    await logger.warn('stock.low', `⚠️ Only ${left} ${kit} kit(s) left in the chest. Time to restock.`);
  } else if (left > lowThreshold && wasLow) {
    await logger.info('stock.restocked', `✅ The ${kit} chest has been restocked (${left} kits).`);
  }
  return { prev, left };
}

module.exports = { readStock, recordStock };
