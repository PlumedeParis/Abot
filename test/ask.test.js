'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAsker, toChatLine } = require('../src/ask');
const { createRequestHandler, parseCommand } = require('../src/requests');
const bans = require('../src/bans');
const { sqliteDb, testSettings, fakeLogger, member } = require('./helpers');

const S = testSettings();

function fakeFetch(respond) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return respond(calls.length);
  };
  fn.calls = calls;
  return fn;
}
const okText = (text) => ({ ok: true, status: 200, text: async () => text });

test('!ask is parsed with the question text kept as typed', () => {
  assert.deepEqual(parseCommand('!ask What is the BEST sword enchant?', S.chat, S.ask), { type: 'ask', question: 'What is the BEST sword enchant?' });
  assert.deepEqual(parseCommand('!ASK', S.chat, S.ask), { type: 'ask', question: '' });
  assert.equal(parseCommand('!asking', S.chat, S.ask), null);
  assert.equal(parseCommand('!ask hi', S.chat, null), null, 'off when ask settings are missing');
});

test('answers become one safe chat line', () => {
  assert.equal(toChatLine('**Sharpness V**\nand Mending.', 200), 'Sharpness V and Mending.');
  assert.equal(toChatLine('/kill everyone', 200), 'kill everyone', 'never runs as a command');
  assert.ok(toChatLine(`${'word '.repeat(30)}. ${'more '.repeat(40)}`, 100).length <= 100);
});

test('the asker uses the free Pollinations API, privately, with a one-line instruction', async () => {
  const fetchFn = fakeFetch(() => okText('Use Sharpness V, Unbreaking III and Mending.'));
  const ask = createAsker({ url: 'https://text.pollinations.ai/', model: 'openai', logger: fakeLogger(), fetchFn });
  assert.deepEqual(await ask('best sword enchants?', 'Steve'), { ok: true, answer: 'Use Sharpness V, Unbreaking III and Mending.' });
  const { url, body } = fetchFn.calls[0];
  assert.equal(url, 'https://text.pollinations.ai/');
  assert.equal(body.model, 'openai');
  assert.equal(body.private, true);
  assert.match(body.messages[0].content, /one single line/);
  assert.match(body.messages[1].content, /Steve: best sword enchants\?/);
});

test('a slow or failing free AI is retried once, then reported, never posted', async () => {
  const logger = fakeLogger();
  const flaky = fakeFetch((n) => (n === 1 ? { ok: false, status: 502, text: async () => '' } : okText('Second try worked.')));
  assert.equal((await createAsker({ url: 'https://x/', model: 'm', logger, fetchFn: flaky })('q', 'Steve')).answer, 'Second try worked.');
  const down = fakeFetch(() => {
    const e = new Error('timed out');
    e.name = 'TimeoutError';
    throw e;
  });
  const r = await createAsker({ url: 'https://x/', model: 'm', logger, fetchFn: down })('q', 'Steve');
  assert.equal(r.ok, false);
  assert.equal(down.calls.length, 2);
  assert.ok(logger.has('ask.error'));
  assert.equal(createAsker({ url: '', model: 'm', logger }), null, 'url "" turns it off');
});

async function setup({ ask }) {
  const db = await sqliteDb();
  const whispers = [];
  const said = [];
  const handle = createRequestHandler({
    db,
    getSettings: () => S,
    getRuntime: () => ({ minecraftReady: true }),
    logger: fakeLogger(),
    checkMembership: member,
    getOnlinePlayer: (name) => ({ username: name, uuid: null }),
    reply: async (player, msg) => whispers.push(`${player}: ${msg}`),
    sayPublic: async (text) => said.push(text),
    ask
  });
  return { db, handle, whispers, said };
}

test('!ask answers everyone in the public chat, in order, with no cooldown', async () => {
  const h = await setup({
    ask: async (q, p) => {
      await new Promise((r) => setTimeout(r, p === 'Steve' ? 30 : 5)); // Steve's answer is slower
      return { ok: true, answer: `${q}!` };
    }
  });
  await Promise.all([h.handle('Steve', '!ask one'), h.handle('Alex', '!ask two'), h.handle('Bob', '!ask three')]);
  assert.deepEqual(h.said, ['[AI] Steve: one!', '[AI] Alex: two!', '[AI] Bob: three!'], 'answered in the order asked');
  await new Promise((r) => setTimeout(r, 3100)); // the general anti-duplicate filter is 3 s
  await h.handle('Steve', '!ask four');
  assert.equal(h.said.at(-1), '[AI] Steve: four!', 'no per-player cooldown');
  assert.equal(h.whispers.length, 0);
});

test('!ask when the AI fails, without a question, or from a banned player', async () => {
  const off = await setup({ ask: null });
  await off.handle('Steve', '!ask hello');
  assert.equal(off.whispers.at(-1), 'Steve: !ask is not available right now.');
  const failing = await setup({ ask: async () => ({ ok: false, reason: 'unavailable' }) });
  await failing.handle('Steve', '!ask hello');
  assert.equal(failing.whispers.at(-1), 'Steve: The AI did not answer, try again later.');
  assert.equal(failing.said.length, 0);
  const h = await setup({ ask: async () => ({ ok: true, answer: 'x' }) });
  await h.handle('Steve', '!ask');
  assert.equal(h.whispers.at(-1), 'Steve: Usage: !ask <your question>');
  await bans.banPlayer(h.db, { query: 'Griefer', bannedBy: 'admin' });
  await h.handle('Griefer', '!ask hello');
  assert.equal(h.whispers.at(-1), 'Griefer: You are banned from the kit bot.');
  assert.equal(h.said.length, 0);
});
