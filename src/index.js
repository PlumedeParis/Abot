'use strict';

// VoidKits.
//   node src/index.js            Minecraft and Discord bots in one process
//   node src/index.js minecraft  only the Minecraft bot
//   node src/index.js discord    only the Discord bot
// Exit code 2 means a setup problem (configuration, token, invite): restarting will not help.

const { loadDotEnv, loadConfig, loadSecrets, secretValues } = require('./config');
const { openDatabase, setStatus } = require('./db');
const { createLogger, createRedactor } = require('./log');
const { createMembershipChecker } = require('./membership');
const { resolveDiscord } = require('./discord/setup');

async function main() {
  loadDotEnv();
  const role = (process.argv[2] || process.env.KITBOT_ROLE || 'all').toLowerCase();
  if (!['all', 'minecraft', 'discord'].includes(role)) throw new Error(`Unknown role "${role}" (all, minecraft or discord)`);
  const config = loadConfig({ role });
  const logger = createLogger({ secrets: secretValues(config.secrets), consoleLevel: config.settings.logging.consoleLevel });
  const db = await openDatabase(config.secrets.database);
  await logger.setDatabase(db);
  await logger.info('bot.start', `VoidKits starting (${role}; ${db.dialect}; Minecraft ${config.secrets.minecraft.version} as ${config.secrets.minecraft.username || '-'}; settings: ${config.source}).`);

  let lastHint = 0;
  const discord = await resolveDiscord({
    ...config.secrets.discord,
    waitForInviteMs: 15 * 60000,
    onWaiting: async (invite) => {
      if (Date.now() - lastHint < 60000) return;
      lastHint = Date.now();
      await logger.warn('discord.setup', `The Discord bot is not in any server yet. Add it with this link (waiting up to 15 minutes): ${invite}`);
    }
  });
  Object.assign(config.secrets.discord, { guildId: discord.guildId, logChannelId: discord.logChannelId, deliveriesChannelId: discord.deliveriesChannelId, adminIds: discord.adminIds });
  for (const note of discord.notes) await logger.info('discord.setup', note);

  const checkMembership = createMembershipChecker({
    token: config.secrets.discord.token,
    guildId: discord.guildId,
    requiredRoleId: config.settings.linking.requiredRoleId,
    timeoutMs: config.settings.discord.membershipTimeoutMs
  });

  const parts = [];
  if (role !== 'minecraft') parts.push(require('./discord/bot').createDiscordBot({ config, db, logger, checkMembership, botName: config.secrets.minecraft.username || 'VoidKits' }));
  if (role !== 'discord') parts.push(require('./minecraft').createMinecraftBot({ config, db, logger, checkMembership }));

  let stopping = false;
  async function shutdown(why, code = 0) {
    if (stopping) return;
    stopping = true;
    await logger.info('bot.stop', `VoidKits stopping (${why}).`);
    setTimeout(() => process.exit(1), 90000).unref();
    // Minecraft first (finishes the current delivery), Discord last (posts the last logs).
    for (const p of [...parts].reverse()) await p.stop().catch((e) => console.error(logger.redact(`Shutdown error: ${e.message}`)));
    await setStatus(db, 'process', { running: false, stoppedAt: Date.now() }).catch(() => {});
    await db.close().catch(() => {});
    process.exit(code);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) => logger.error('process.unhandled', `Unhandled error: ${e?.message || e}`));
  process.on('uncaughtException', (e) => logger.error('process.crash', `Crash: ${e.message}`).finally(() => shutdown('crash', 1)));

  await setStatus(db, 'process', { running: true, role, startedAt: Date.now() });
  for (const p of parts) await p.start();
}

main().catch((e) => {
  const redact = createRedactor(secretValues(loadSecrets(process.env)));
  console.error(`[${new Date().toISOString()}] FATAL ${redact(e.message)}`);
  process.exit(2);
});
