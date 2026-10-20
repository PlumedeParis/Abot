'use strict';

// Fills in Discord settings that were not provided, using only the bot token:
//   - server: the single server the bot is in (DISCORD_GUILD_ID overrides)
//   - log channel: an existing text channel named "kitbot-logs", or a new
//     private one the bot creates (needs the Manage Channels permission)
//   - administrators: the server owner (DISCORD_ADMIN_IDS overrides)

const { REST, Routes, DiscordAPIError } = require('discord.js');

const VIEW_CHANNEL = 1n << 10n;
const SEND_MESSAGES = 1n << 11n;
const EMBED_LINKS = 1n << 14n;
const MANAGE_CHANNELS = 1n << 4n;
const INVITE_PERMISSIONS = VIEW_CHANNEL | SEND_MESSAGES | EMBED_LINKS | MANAGE_CHANNELS; // 19472

function inviteUrl(applicationId) {
  return `https://discord.com/oauth2/authorize?client_id=${applicationId}&scope=bot%20applications.commands&permissions=${INVITE_PERMISSIONS}`;
}

async function withRetries(fn, attempts = 3, delayMs = 5000) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      // Definite answers from Discord (bad token, missing access) are not retried.
      if (e instanceof DiscordAPIError || i >= attempts) throw e;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function resolveDiscordContext({ token, guildId = '', logChannelId = '', adminIds = [], logChannelName = 'kitbot-logs', rest = null, retryDelayMs = 5000 }) {
  const api = rest || new REST({ version: '10', timeout: 15000 }).setToken(token);
  const call = (fn) => withRetries(fn, 3, retryDelayMs);
  const notes = [];

  let me;
  try {
    me = await call(() => api.get(Routes.user()));
  } catch (e) {
    if (e instanceof DiscordAPIError && e.status === 401) throw new Error('DISCORD_TOKEN is invalid. Copy a fresh token from the Discord Developer Portal (Bot tab, Reset Token).');
    throw new Error(`Could not reach Discord: ${e.message}`);
  }
  const invite = inviteUrl(me.id);

  if (!guildId) {
    const guilds = await call(() => api.get(Routes.userGuilds()));
    if (guilds.length === 0) throw new Error(`The Discord bot is not in any server yet. Invite it with: ${invite}`);
    if (guilds.length > 1) throw new Error(`The Discord bot is in ${guilds.length} servers; set DISCORD_GUILD_ID to choose one.`);
    guildId = guilds[0].id;
    notes.push(`Using Discord server "${guilds[0].name}".`);
  }

  if (!adminIds.length) {
    const guild = await call(() => api.get(Routes.guild(guildId)));
    adminIds = [guild.owner_id];
    notes.push('Administrator: the server owner (set DISCORD_ADMIN_IDS to add others).');
  }

  if (!logChannelId) {
    const channels = await call(() => api.get(Routes.guildChannels(guildId)));
    const existing = channels.find((c) => c.type === 0 && c.name === logChannelName);
    if (existing) {
      logChannelId = existing.id;
      notes.push(`Log channel: #${logChannelName}.`);
    } else {
      try {
        const created = await call(() =>
          api.post(Routes.guildChannels(guildId), {
            body: {
              name: logChannelName,
              type: 0,
              topic: 'KitBot events (private to the bot and administrators)',
              permission_overwrites: [
                // The @everyone role has the same ID as the server.
                { id: guildId, type: 0, deny: String(VIEW_CHANNEL) },
                { id: me.id, type: 1, allow: String(VIEW_CHANNEL | SEND_MESSAGES | EMBED_LINKS) },
                ...adminIds.map((id) => ({ id, type: 1, allow: String(VIEW_CHANNEL) }))
              ]
            }
          })
        );
        logChannelId = created.id;
        notes.push(`Created the private log channel #${logChannelName}.`);
      } catch (e) {
        throw new Error(
          `Could not create the #${logChannelName} channel (${e.message}). Either create a text channel named "${logChannelName}" that the bot can see, or re-invite the bot with this link, which includes the Manage Channels permission: ${invite}`
        );
      }
    }
  }

  return { guildId, logChannelId, adminIds, botUserId: me.id, inviteUrl: invite, notes };
}

module.exports = { resolveDiscordContext, inviteUrl, INVITE_PERMISSIONS };
