'use strict';

// Entry point.
//   node src/index.js            run both bots in one process (default)
//   node src/index.js minecraft  run only the Minecraft bot
//   node src/index.js discord    run only the Discord bot
// Both roles share the same database; running them as separate processes
// requires PostgreSQL (DATABASE_URL) or SQLite on the same machine.

const { loadDotEnv, loadConfig, loadSecrets, secretValues } = require('./config');
const { openDatabase, setStatus } = require('./database');
const { createLogger, createRedactor } = require('./logging');
const { createMembershipChecker } = require('./membership');

async function main() {
  loadDotEnv();
  const role = (process.argv[2] || process.env.KITBOT_ROLE || 'all').toLowerCase();
  if (!['all', 'minecraft', 'discord'].includes(role)) throw new Error(`Unknown role "${role}" (use all, minecraft or discord)`);

  const config = loadConfig({ role });
  const logger = createLogger({ secretValues: secretValues(config.secrets), consoleLevel: config.settings.logging.consoleLevel, source: role });
  const db = await openDatabase(config.secrets.database);
  await logger.setDatabase(db);
  await logger.info('bot.startup', `KitBot starting (role: ${role}, storage: ${db.dialect}, Minecraft ${config.secrets.minecraft.version}).`);

  const checkMembership = createMembershipChecker({
    token: config.secrets.discord.token,
    guildId: config.secrets.discord.guildId,
    requiredRoleId: config.settings.linking.requiredRoleId,
    timeoutMs: config.settings.discord.membershipTimeoutMs
  });

  const parts = [];
  if (role === 'all' || role === 'discord') {
    const { createDiscordBot } = require('./discord');
    parts.push(createDiscordBot({ config, db, logger, checkMembership }));
  }
  if (role === 'all' || role === 'minecraft') {
    const { createMinecraftBot } = require('./minecraft');
    parts.push(createMinecraftBot({ config, db, logger, checkMembership }));
  }

  let shuttingDown = false;
  async function shutdown(signal, exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    await logger.info('bot.shutdown', `KitBot shutting down (${signal}).`);
    const force = setTimeout(() => process.exit(1), 90000);
    force.unref();
    // Stop Minecraft first (finishes or aborts the current delivery), then
    // Discord last so it can flush the final log events.
    for (const p of [...parts].reverse()) {
      try {
        await p.stop();
      } catch (e) {
        console.error(logger.redact(`Error during shutdown: ${e.message}`));
      }
    }
    await setStatus(db, 'process', { running: false, stoppedAt: Date.now() }).catch(() => {});
    await db.close().catch(() => {});
    process.exit(exitCode);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) => logger.error('process.unhandled', `Unhandled rejection: ${e && e.message ? e.message : e}`));
  process.on('uncaughtException', (e) => {
    logger.error('process.crash', `Uncaught exception: ${e.message}`).finally(() => shutdown('uncaughtException', 1));
  });

  await setStatus(db, 'process', { running: true, role, startedAt: Date.now() });
  for (const p of parts) await p.start();
}

main().catch((e) => {
  const redact = createRedactor(secretValues(loadSecrets(process.env)));
  console.error(`[${new Date().toISOString()}] FATAL ${redact(e.message)}`);
  process.exit(1);
});
