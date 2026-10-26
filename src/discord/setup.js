'use strict';

// Fills in what was not configured, using only the bot token:
//   server: the only server the bot is in (DISCORD_GUILD_ID to choose)
//   #kitbot-logs and #delivered-kits: found, or created private
//   administrators: the server owner (DISCORD_ADMIN_IDS to choose)

const { REST, Routes, DiscordAPIError } = require('discord.js');

const VIEW = 1n << 10n;
const SEND = 1n << 11n;
const EMBED = 1n << 14n;
const MANAGE_CHANNELS = 1n << 4n;
const INVITE_PERMISSIONS = VIEW | SEND | EMBED | MANAGE_CHANNELS;

const inviteUrl = (appId) => `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot%20applications.commands&permissions=${INVITE_PERMISSIONS}`;

async function retry(fn, delayMs) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof DiscordAPIError || i >= 3) throw e; // a definite answer is not retried
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function resolveDiscord({ token, guildId = '', logChannelId = '', deliveriesChannelId = '', adminIds = [], rest = null, retryDelayMs = 5000, waitForInviteMs = 0, pollMs = 15000, onWaiting = () => {} }) {
  const api = rest || new REST({ version: '10', timeout: 15000 }).setToken(token);
  const call = (fn) => retry(fn, retryDelayMs);
  const notes = [];
  let me;
  try {
    me = await call(() => api.get(Routes.user()));
  } catch (e) {
    if (e instanceof DiscordAPIError && e.status === 401) throw new Error('DISCORD_TOKEN is invalid: copy a new token from the Discord Developer Portal (Bot tab, Reset Token).');
    throw new Error(`Could not reach Discord: ${e.message}`);
  }
  const invite = inviteUrl(me.id);

  if (!guildId) {
    let guilds = await call(() => api.get(Routes.userGuilds()));
    const deadline = Date.now() + waitForInviteMs;
    while (!guilds.length && Date.now() < deadline) {
      await onWaiting(invite);
      await new Promise((r) => setTimeout(r, pollMs));
      guilds = await call(() => api.get(Routes.userGuilds()));
    }
    if (!guilds.length) throw new Error(`The Discord bot is in no server. Invite it: ${invite}`);
    if (guilds.length > 1) throw new Error(`The Discord bot is in ${guilds.length} servers: set DISCORD_GUILD_ID to choose one.`);
    guildId = guilds[0].id;
    notes.push(`Discord server: "${guilds[0].name}".`);
  }
  if (!adminIds.length) {
    adminIds = [(await call(() => api.get(Routes.guild(guildId)))).owner_id];
    notes.push('Administrator: the server owner (DISCORD_ADMIN_IDS adds others).');
  }

  let channels = null;
  async function privateChannel(name, topic) {
    channels = channels || (await call(() => api.get(Routes.guildChannels(guildId))));
    const found = channels.find((c) => c.type === 0 && c.name === name);
    if (found) return { id: found.id, created: false };
    const created = await call(() =>
      api.post(Routes.guildChannels(guildId), {
        body: {
          name,
          type: 0,
          topic,
          permission_overwrites: [
            { id: guildId, type: 0, deny: String(VIEW) }, // @everyone
            { id: me.id, type: 1, allow: String(VIEW | SEND | EMBED) },
            ...adminIds.map((id) => ({ id, type: 1, allow: String(VIEW) }))
          ]
        }
      })
    );
    return { id: created.id, created: true };
  }

  if (!logChannelId) {
    try {
      const ch = await privateChannel('kitbot-logs', 'VoidKits events (bot and administrators only)');
      logChannelId = ch.id;
      notes.push(ch.created ? 'Created the private #kitbot-logs channel.' : 'Log channel: #kitbot-logs.');
    } catch (e) {
      throw new Error(`Could not create #kitbot-logs (${e.message}). Create a text channel named "kitbot-logs" the bot can see, or re-invite the bot with Manage Channels: ${invite}`);
    }
  }
  if (!deliveriesChannelId) {
    try {
      const ch = await privateChannel('delivered-kits', 'One report per delivered kit (bot and administrators only)');
      deliveriesChannelId = ch.id;
      notes.push(ch.created ? 'Created the private #delivered-kits channel.' : 'Delivery reports: #delivered-kits.');
    } catch {
      deliveriesChannelId = logChannelId;
      notes.push('Delivery reports go to #kitbot-logs (#delivered-kits could not be created).');
    }
  }
  return { guildId, logChannelId, deliveriesChannelId, adminIds, botUserId: me.id, invite, notes };
}

module.exports = { resolveDiscord, inviteUrl, INVITE_PERMISSIONS };
