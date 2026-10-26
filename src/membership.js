'use strict';

// Live check that a Discord account is in the server (REST API). Fails closed:
// anything but a definite answer is "unavailable" and nothing is delivered.

const { REST, Routes, DiscordAPIError } = require('discord.js');

const UNKNOWN_MEMBER = 10007;
const UNKNOWN_USER = 10013;

function createMembershipChecker({ token, guildId, requiredRoleId = null, timeoutMs = 8000, rest = null }) {
  const api = rest || new REST({ version: '10', timeout: timeoutMs, retries: 1 }).setToken(token);
  return async function checkMembership(discordId) {
    if (!/^\d{15,22}$/.test(String(discordId))) return { status: 'not_member' };
    try {
      const member = await api.get(Routes.guildMember(guildId, discordId));
      if (!member?.user) return { status: 'unavailable' };
      if (requiredRoleId && !(member.roles || []).includes(requiredRoleId)) return { status: 'missing_role' };
      return { status: 'member' };
    } catch (e) {
      if (e instanceof DiscordAPIError && (e.code === UNKNOWN_MEMBER || e.code === UNKNOWN_USER)) return { status: 'not_member' };
      return { status: 'unavailable' };
    }
  };
}

module.exports = { createMembershipChecker };
