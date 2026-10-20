'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DiscordAPIError } = require('discord.js');
const { resolveDiscordContext, INVITE_PERMISSIONS } = require('../src/discord-setup');

const BOT = '100000000000000001';
const GUILD = '200000000000000002';
const OWNER = '300000000000000003';

function fakeRest({ guilds = [{ id: GUILD, name: 'VoidClan' }], channels = [], createFails = false } = {}) {
  const posts = [];
  return {
    posts,
    get: async (route) => {
      if (route === '/users/@me') return { id: BOT };
      if (route === '/users/@me/guilds') return guilds;
      if (route === `/guilds/${GUILD}`) return { id: GUILD, owner_id: OWNER };
      if (route === `/guilds/${GUILD}/channels`) return channels;
      throw new Error(`unexpected route ${route}`);
    },
    post: async (route, { body }) => {
      if (createFails) throw new DiscordAPIError({ code: 50013, message: 'Missing Permissions' }, 50013, 403, 'POST', route, {});
      posts.push({ route, body });
      return { id: '400000000000000004', name: body.name };
    }
  };
}

test('only a token is needed: server, owner admin and a private log channel are set up', async () => {
  const rest = fakeRest();
  const ctx = await resolveDiscordContext({ token: 'x', rest });
  assert.equal(ctx.guildId, GUILD);
  assert.deepEqual(ctx.adminIds, [OWNER]);
  assert.equal(ctx.logChannelId, '400000000000000004');
  const ow = rest.posts[0].body.permission_overwrites;
  assert.deepEqual(ow[0], { id: GUILD, type: 0, deny: String(1n << 10n) }, '@everyone cannot see the channel');
  assert.ok(ow.some((o) => o.id === BOT && o.type === 1));
  assert.ok(ow.some((o) => o.id === OWNER && o.type === 1));
  assert.equal(String(INVITE_PERMISSIONS), '19472');
});

test('an existing #kitbot-logs channel is reused and configured values win', async () => {
  const rest = fakeRest({ channels: [{ id: '500000000000000005', type: 0, name: 'kitbot-logs' }] });
  const ctx = await resolveDiscordContext({ token: 'x', rest, adminIds: ['600000000000000006'] });
  assert.equal(ctx.logChannelId, '500000000000000005');
  assert.deepEqual(ctx.adminIds, ['600000000000000006']);
  assert.equal(rest.posts.length, 0);
});

test('clear errors when the bot is in no server or several servers', async () => {
  await assert.rejects(resolveDiscordContext({ token: 'x', rest: fakeRest({ guilds: [] }) }), /not in any server yet.*permissions=19472/);
  await assert.rejects(resolveDiscordContext({ token: 'x', rest: fakeRest({ guilds: [{ id: '1' }, { id: '2' }] }) }), /DISCORD_GUILD_ID/);
});

test('missing Manage Channels permission explains how to fix it', async () => {
  await assert.rejects(resolveDiscordContext({ token: 'x', rest: fakeRest({ createFails: true }) }), /create a text channel named "kitbot-logs".*permissions=19472/);
});

test('invalid token is reported as such', async () => {
  const rest = {
    get: async () => {
      throw new DiscordAPIError({ code: 0, message: '401: Unauthorized' }, 0, 401, 'GET', '/users/@me', {});
    }
  };
  await assert.rejects(resolveDiscordContext({ token: 'bad', rest }), /DISCORD_TOKEN is invalid/);
});
