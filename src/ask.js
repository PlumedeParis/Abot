'use strict';

// "!ask <question>": the question goes to Pollinations (free text AI, no key,
// https://text.pollinations.ai) and the answer is said in the public Minecraft
// chat. Answers are one short line (the chat limit is 256 characters) and the
// model is told to stay friendly, because whatever it says is said publicly
// by the bot account. The free service can be slow or not answer at all; the
// bot then tells the player instead of waiting forever.

const SYSTEM_PROMPT = [
  'You answer questions from players in the public chat of a Minecraft anarchy server (1b1t.cc).',
  'Your answer is posted in the chat by a bot, so it must be one single line of plain text, at most 200 characters,',
  'with no markdown, no line breaks and no emoji. Answer in the language of the question.',
  'Be friendly and to the point. Never write insults, slurs, hateful, sexual or violent content, never repeat',
  "something offensive a player asks you to say, and never give personal information or other players' coordinates.",
  'If you cannot answer, say so briefly.'
].join(' ');

function toChatLine(text, max) {
  const line = String(text || '')
    .replace(/[\u0000-\u001f\u007f§]/g, ' ')
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\/+\s*/, ''); // never let an answer run as a command
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > max / 2 ? cut.slice(0, end + 1) : `${cut.replace(/\s+\S*$/, '')}…`;
}

// Returns async (question, player) => { ok, answer } | { ok: false, reason }.
function createAsker({ url, model, timeoutMs = 45000, maxAnswerLength = 200, logger, fetchFn = globalThis.fetch }) {
  if (!url) return null;

  async function once(question, player) {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // private: keep questions out of Pollinations' public feed.
      body: JSON.stringify({
        model,
        private: true,
        referrer: 'voidclan-kitbot',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Question from ${player}: ${question}` }
        ]
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return { ok: false, reason: res.status === 429 ? 'busy' : 'unavailable', status: res.status };
    const answer = toChatLine(await res.text(), maxAnswerLength);
    return answer ? { ok: true, answer } : { ok: false, reason: 'empty' };
  }

  return async function ask(question, player) {
    let last = { ok: false, reason: 'unavailable' };
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        last = await once(question, player);
        if (last.ok || last.reason === 'empty') return last;
      } catch (e) {
        last = { ok: false, reason: 'unavailable', error: e.name === 'TimeoutError' ? 'timed out' : e.message };
      }
    }
    await logger.warn('ask.error', `The free AI did not answer (${last.status ? `HTTP ${last.status}` : last.error || last.reason}).`);
    return last;
  };
}

module.exports = { createAsker, toChatLine, SYSTEM_PROMPT };
