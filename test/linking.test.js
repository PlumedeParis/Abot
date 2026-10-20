'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const linking = require('../src/linking');
const { BACKENDS, testSettings, member, MIN, DAY } = require('./helpers');

const S = testSettings();
const T0 = Date.UTC(2026, 0, 1);
const ALICE = '300000000000000001';
const BOB = '300000000000000002';

async function link(db, discordId, name, now, opts = {}) {
  const start = await linking.startLink(db, { discordId, mcUsername: name, settings: opts.settings || S, now, replaceUsername: opts.replace });
  if (!start.ok) return start;
  return linking.completeLink(db, {
    mcUsername: opts.ingameName || name,
    mcUuid: opts.uuid || null,
    code: start.code,
    settings: opts.settings || S,
    checkMembership: opts.checkMembership || member,
    now: now + 1000
  });
}

test('codes are random, well-formed and hashed', () => {
  const a = linking.generateCode();
  const b = linking.generateCode();
  assert.match(a, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.notEqual(a, b);
  assert.equal(linking.hashCode(a), linking.hashCode(a.toLowerCase().replace('-', '')));
});

test('username validation rejects injection attempts', () => {
  for (const bad of ['', 'ab', 'a'.repeat(17), 'Steve; DROP TABLE', 'Steve\n/op me', 'Ste ve', "x'--"]) {
    assert.equal(linking.isValidUsername(bad), false, bad);
  }
  assert.equal(linking.isValidUsername('Plume_2'), true);
});

for (const [name, open] of BACKENDS) {
  test(`[${name}] a link requires the code to be sent from the claimed Minecraft account`, async () => {
    const db = await open();
    const start = await linking.startLink(db, { discordId: ALICE, mcUsername: 'Alice', settings: S, now: T0 });
    assert.equal(start.ok, true);

    // Someone else sends the code in-game: rejected, nothing linked.
    const stolen = await linking.completeLink(db, { mcUsername: 'Mallory', code: start.code, settings: S, checkMembership: member, now: T0 + 1000 });
    assert.equal(stolen.ok, false);
    assert.equal(await linking.getActiveLinkByUsername(db, 'Alice'), undefined);

    const ok = await linking.completeLink(db, { mcUsername: 'alice', mcUuid: 'uuid-a', code: start.code, settings: S, checkMembership: member, now: T0 + 2000 });
    assert.equal(ok.ok, true);
    const row = await linking.getActiveLinkByUsername(db, 'ALICE');
    assert.equal(row.discord_id, ALICE);
    assert.equal(row.mc_uuid, 'uuid-a');
    assert.equal(row.verification_status, 'verified');
    assert.equal(Number(row.linked_at), T0 + 2000);

    // Single use.
    const again = await linking.completeLink(db, { mcUsername: 'alice', code: start.code, settings: S, checkMembership: member, now: T0 + 3000 });
    assert.equal(again.ok, false);
    await db.close();
  });

  test(`[${name}] expired codes are rejected`, async () => {
    const db = await open();
    const start = await linking.startLink(db, { discordId: ALICE, mcUsername: 'Alice', settings: S, now: T0 });
    const r = await linking.completeLink(db, { mcUsername: 'Alice', code: start.code, settings: S, checkMembership: member, now: T0 + 11 * MIN });
    assert.equal(r.reason, 'expired_code');
    await db.close();
  });

  test(`[${name}] a new code invalidates the previous one`, async () => {
    const db = await open();
    const first = await linking.startLink(db, { discordId: ALICE, mcUsername: 'Alice', settings: S, now: T0 });
    await linking.startLink(db, { discordId: ALICE, mcUsername: 'Alice', settings: S, now: T0 + 1000 });
    const r = await linking.completeLink(db, { mcUsername: 'Alice', code: first.code, settings: S, checkMembership: member, now: T0 + 2000 });
    assert.equal(r.ok, false);
    await db.close();
  });

  test(`[${name}] another player cannot take over a linked account`, async () => {
    const db = await open();
    assert.equal((await link(db, ALICE, 'Alice', T0, { uuid: 'uuid-a' })).ok, true);
    const r = await linking.startLink(db, { discordId: BOB, mcUsername: 'Alice', settings: S, now: T0 + DAY });
    assert.equal(r.reason, 'taken');
    // UUID reuse under a new name is also blocked.
    const r2 = await link(db, BOB, 'Alice2', T0 + DAY, { uuid: 'uuid-a' });
    assert.equal(r2.reason, 'taken');
    assert.equal((await linking.getActiveLinkByUsername(db, 'Alice')).discord_id, ALICE);
    await db.close();
  });

  test(`[${name}] membership is verified before a link is finalised (fails closed)`, async () => {
    const db = await open();
    const notMember = await link(db, ALICE, 'Alice', T0, { checkMembership: async () => ({ status: 'not_member' }) });
    assert.equal(notMember.reason, 'not_member');
    const down = await link(db, ALICE, 'Alice', T0 + MIN, { checkMembership: async () => ({ status: 'unavailable' }) });
    assert.equal(down.reason, 'discord_unavailable');
    assert.equal(await linking.getActiveLinkByUsername(db, 'Alice'), undefined);
    await db.close();
  });

  test(`[${name}] username change allowed once every 30 days, with history`, async () => {
    const db = await open();
    await link(db, ALICE, 'Alice', T0, { uuid: 'uuid-a' });
    const early = await linking.startLink(db, { discordId: ALICE, mcUsername: 'AliceNew', settings: S, now: T0 + 29 * DAY });
    assert.equal(early.reason, 'change_too_soon');
    assert.equal(early.retryAt, T0 + 1000 + 30 * DAY);

    const changed = await link(db, ALICE, 'AliceNew', T0 + 31 * DAY, { uuid: 'uuid-b' });
    assert.equal(changed.ok, true);
    assert.equal(changed.mode, 'change');
    assert.equal(changed.previous, 'Alice');
    assert.equal(await linking.getActiveLinkByUsername(db, 'Alice'), undefined);
    const row = await linking.getActiveLinkByUsername(db, 'AliceNew');
    assert.equal(row.mc_uuid, 'uuid-b');
    assert.equal(Number(row.last_username_change_at), T0 + 31 * DAY + 1000);

    // The next change is again blocked for 30 days.
    assert.equal((await linking.startLink(db, { discordId: ALICE, mcUsername: 'Alice3', settings: S, now: T0 + 40 * DAY })).reason, 'change_too_soon');
    const hist = await linking.getHistory(db, ALICE);
    assert.deepEqual(
      hist.map((h) => h.action),
      ['change', 'link']
    );
    assert.equal(hist[0].old_username, 'Alice');
    assert.equal(hist[0].new_username, 'AliceNew');
    await db.close();
  });

  test(`[${name}] unlinking does not reset the 30-day rule, re-linking the same name is allowed`, async () => {
    const db = await open();
    await link(db, ALICE, 'Alice', T0);
    await linking.revokeLinks(db, ALICE, 'left the Discord server', T0 + DAY);
    assert.equal((await linking.startLink(db, { discordId: ALICE, mcUsername: 'Other', settings: S, now: T0 + 2 * DAY })).reason, 'change_too_soon');
    assert.equal((await link(db, ALICE, 'Alice', T0 + 2 * DAY)).ok, true);
    await db.close();
  });

  test(`[${name}] change is validated again when the code is used`, async () => {
    const db = await open();
    await link(db, ALICE, 'Alice', T0);
    const start = await linking.startLink(db, { discordId: ALICE, mcUsername: 'Target', settings: S, now: T0 + 31 * DAY });
    assert.equal(start.ok, true);
    // Bob links "Target" first; Alice's pending change must not steal it.
    await link(db, BOB, 'Target', T0 + 31 * DAY + 10);
    const r = await linking.completeLink(db, { mcUsername: 'Target', code: start.code, settings: S, checkMembership: member, now: T0 + 31 * DAY + 5000 });
    assert.equal(r.ok, false);
    assert.equal((await linking.getActiveLinkByUsername(db, 'Alice')).discord_id, ALICE, 'old link kept');
    assert.equal((await linking.getActiveLinkByUsername(db, 'Target')).discord_id, BOB);
    await db.close();
  });

  test(`[${name}] configurable number of links per Discord account`, async () => {
    const db = await open();
    const two = testSettings({ linking: { maxLinksPerDiscord: 2 } });
    assert.equal((await link(db, ALICE, 'Alice', T0, { settings: two })).ok, true);
    assert.equal((await link(db, ALICE, 'AliceAlt', T0 + MIN, { settings: two })).ok, true);
    assert.equal((await linking.startLink(db, { discordId: ALICE, mcUsername: 'Third', settings: two, now: T0 + 31 * DAY })).reason, 'limit_reached');
    const replaced = await link(db, ALICE, 'Third', T0 + 31 * DAY, { settings: two, replace: 'AliceAlt' });
    assert.equal(replaced.ok, true);
    assert.equal(replaced.previous, 'AliceAlt');
    assert.equal((await linking.getActiveLinksForDiscord(db, ALICE)).length, 2);
    await db.close();
  });

  test(`[${name}] repeated wrong codes are rate limited`, async () => {
    const db = await open();
    for (let i = 0; i < 5; i++) {
      const r = await linking.completeLink(db, { mcUsername: 'Alice', code: 'AAAA-AAAA', settings: S, checkMembership: member, now: T0 + i });
      assert.equal(r.reason, 'invalid_code');
    }
    const start = await linking.startLink(db, { discordId: ALICE, mcUsername: 'Alice', settings: S, now: T0 + 10 });
    const r = await linking.completeLink(db, { mcUsername: 'Alice', code: start.code, settings: S, checkMembership: member, now: T0 + 20 });
    assert.equal(r.reason, 'too_many_attempts');
    await db.close();
  });

  test(`[${name}] revoking cancels queued requests`, async () => {
    const db = await open();
    await link(db, ALICE, 'Alice', T0);
    await db.run("INSERT INTO requests (discord_id, mc_username, mc_username_lower, kit, status, created_at) VALUES (?, 'Alice', 'alice', 'totem', 'queued', ?)", [ALICE, T0]);
    const revoked = await linking.revokeLinks(db, ALICE, 'left the Discord server', T0 + MIN);
    assert.equal(revoked.length, 1);
    assert.equal((await db.get('SELECT status FROM requests')).status, 'cancelled');
    assert.equal(await linking.getActiveLinkByUsername(db, 'Alice'), undefined);
    await db.close();
  });
}
