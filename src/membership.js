'use strict';

// Live Discord server membership checks over the Discord REST API.
// Used by the Minecraft bot for every kit request and link completion, so
// access never relies only on stored data. Fails CLOSED: any error other than
// a definite "not a member" answer returns 'unavailable' and the request is
// rejected.

const { REST, Routes, DiscordAPIError } = require('discord.js');

const UNKNOWN_MEMBER = 10007;
const UNKNOWN_USER = 10013;

function createMembershipChecker({ token, guildId, requiredRoleId = null, timeoutMs = 8000, rest = null }) {
  const client = rest || new REST({ version: '10', timeout: timeoutMs, retries: 1 }).setToken(token);

  return async function checkMembership(discordId) {
    if (!/^\d{15,22}$/.test(String(discordId))) return { status: 'not_member' };
    try {
      const member = await client.get(Routes.guildMember(guildId, discordId));
      if (!member || !member.user) return { status: 'unavailable' };
      if (requiredRoleId && !(member.roles || []).includes(requiredRoleId)) return { status: 'missing_role' };
      return { status: 'member' };
    } catch (e) {
      if (e instanceof DiscordAPIError && (e.code === UNKNOWN_MEMBER || e.code === UNKNOWN_USER)) return { status: 'not_member' };
      return { status: 'unavailable', error: e?.message };
    }
  };
}

module.exports = { createMembershipChecker, UNKNOWN_MEMBER, UNKNOWN_USER };
