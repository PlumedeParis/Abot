'use strict';

// Who said what in the chat.
//
// Minecraft delivers chat in three ways and each is read differently:
//   player chat      (vanilla chat and /msg): the packet carries the sender's
//                    UUID and the exact text typed, so no format is guessed.
//   profileless chat (plugins): the packet carries the sender's display name
//                    and the text separately.
//   system chat      (most chat plugins, e.g. 1b1t.cc): one line of text such
//                    as "OG 1b1ter Steve » !kit pvp". The sender is the name just
//                    before the first separator (», :, >, |, ...): what comes
//                    before it is written by the server, so a player cannot fake
//                    it. The name must belong to a player in the tab list.

const NAME = /(?<![A-Za-z0-9_])[A-Za-z0-9_]{1,16}(?![A-Za-z0-9_])/g;
const ARROW = '(?:->|→|➡|⇒)';
// Characters that end the server-written part of a line.
const SEPARATOR_CHARS = /[»:|>→➡⇒➤➜➔]/;

// Removes colour codes, invisible characters and repeated spaces.
function cleanText(text) {
  return String(text ?? '')
    .replace(/§./g, '')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Chat component (JSON string, object or plain string) -> plain text.
function componentText(value, ChatMessage = null) {
  if (value === null || value === undefined) return '';
  let obj = value;
  if (typeof value === 'string') {
    try {
      obj = JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (typeof obj === 'string') return obj;
  if (ChatMessage) {
    try {
      return new ChatMessage(obj).toString();
    } catch {
      // fall back to collecting the text fields
    }
  }
  const parts = [];
  const walk = (c) => {
    if (c === null || c === undefined) return;
    if (typeof c === 'string' || typeof c === 'number') return void parts.push(String(c));
    if (Array.isArray(c)) return void c.forEach(walk);
    if (typeof c.text === 'string' || typeof c.text === 'number') parts.push(String(c.text));
    else if (typeof c[''] === 'string') parts.push(c['']);
    if (Array.isArray(c.with)) c.with.forEach(walk);
    if (Array.isArray(c.extra)) c.extra.forEach(walk);
  };
  walk(obj);
  return parts.join('');
}

// The tab-list spelling of `candidate`, or null when nobody online has that name.
function onlineName(candidate, online) {
  if (!candidate) return null;
  const lower = candidate.toLowerCase();
  return online.find((n) => n.toLowerCase() === lower) || null;
}

// The player named in a server-written prefix such as "[VIP] OG 1b1ter Steve":
// the last name in it, or else the only online player named in it.
function senderFromPrefix(prefix, online) {
  const names = cleanText(prefix).match(NAME) || [];
  if (!names.length) return null;
  const last = onlineName(names[names.length - 1], online);
  if (last) return last;
  const found = [...new Set(names.map((n) => onlineName(n, online)).filter(Boolean))];
  return found.length === 1 ? found[0] : null;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// One system chat line -> { username, message } | null.
//   options: { online: [names], botName, ignore: RegExp|null, patterns: [RegExp] }
function parseSystemLine(rawLine, { online = [], botName = '', ignore = null, patterns = [] } = {}) {
  const line = cleanText(rawLine);
  if (!line || line.length > 512) return null;
  if (ignore && ignore.test(line)) return null;

  // Formats configured by the owner come first.
  for (const re of patterns) {
    const m = re.exec(line);
    if (m && m.groups && m.groups.username && m.groups.message !== undefined) {
      const username = onlineName(m.groups.username, online);
      if (username) return { username, message: m.groups.message.trim() };
    }
  }

  // Whispers the bot sent itself are echoed back: never commands.
  const me = botName ? `|${escapeRegex(botName)}` : '';
  if (new RegExp(`^(?:\\[(?:me|you${me}) ?${ARROW}|to [A-Za-z0-9_]{1,16}\\b|you whisper)`, 'i').test(line)) return null;

  // Whispers to the bot.
  const target = `(?:me|you${me})`;
  const whispers = [
    /^(.{1,64}?) whispers(?: to you)?: (.*)$/i,
    new RegExp(`^\\[(.{1,64}?) ?${ARROW} ?${target}\\] ?(.*)$`, 'i'),
    new RegExp(`^(.{1,64}?) ?${ARROW} ?${target} ?(?:»|:|>) ?(.*)$`, 'i'),
    /^from (.{1,64}?) ?(?:»|:|>) (.*)$/i
  ];
  for (const re of whispers) {
    const m = re.exec(line);
    if (m) {
      // "Mallory » Steve whispers: !kit" is Mallory's public message, not a whisper.
      if (SEPARATOR_CHARS.test(m[1].replace(/->/g, ''))) break;
      const username = senderFromPrefix(m[1], online);
      return username ? { username, message: m[2].trim() } : null;
    }
  }

  // Everything else: the sender's name is right before the first separator.
  //   "<Steve> hi" (vanilla), "[VIP] <Steve> hi", "OG 1b1ter Steve » hi",
  //   "[VIP] Steve: hi", "Steve > hi"
  const sep = /\s?(?:»|>>|➤|➜|➔|→|⇒|\||:|>)\s/.exec(line);
  if (!sep || sep.index === 0 || sep.index > 64) return null;
  const username = senderFromPrefix(line.slice(0, sep.index), online);
  return username ? { username, message: line.slice(sep.index + sep[0].length).trim() } : null;
}

// Player chat packet (vanilla chat and /msg). The sender comes from the UUID.
//   { senderUuid, plainMessage, senderName (text) }
function parsePlayerChat({ senderUuid, plainMessage, senderName }, { playersByUuid = {}, online = [] } = {}) {
  const message = cleanText(plainMessage);
  if (!message) return null;
  const known = senderUuid && playersByUuid[senderUuid];
  const username = (known && onlineName(known, online)) || senderFromPrefix(senderName || '', online);
  return username ? { username, message } : null;
}

// Profileless chat packet: the sender's display name and the text, separately.
function parseProfilelessChat({ senderName, message }, { online = [] } = {}) {
  const text = cleanText(message);
  const username = senderFromPrefix(senderName || '', online);
  return username && text ? { username, message: text } : null;
}

// True when a line looks like it contains one of the bot's commands.
function mentionsCommand(line, chat) {
  const lower = String(line).toLowerCase();
  return lower.includes(chat.kitCommand.toLowerCase()) || lower.includes(chat.linkCommand.toLowerCase());
}

module.exports = { cleanText, componentText, onlineName, senderFromPrefix, parseSystemLine, parsePlayerChat, parseProfilelessChat, mentionsCommand };
