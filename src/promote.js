'use strict';

// Advertising the kit bot in game: a private message to each player who
// joins the server. It stays quiet while deliveries are impossible (paused,
// maintenance, kit chests not found), so the bot never promises kits it
// cannot give.

function createPromoter({ getSettings, getRuntime, logger, whisper, now = () => Date.now() }) {
  const greeted = new Map(); // name (lower case) -> last welcome time
  let greetFrom = Infinity;

  const canPromote = () => {
    const rt = getRuntime();
    return rt.ready && rt.stationReady && !rt.paused && !rt.maintenance;
  };

  return {
    // Called once the bot is logged in. The tab list it receives on joining
    // lists everyone already online: those players are not "joining", so
    // welcomes only start after a grace period.
    loggedIn({ graceMs = 15000 } = {}) {
      greetFrom = now() + graceMs;
    },

    loggedOut() {
      greetFrom = Infinity;
    },

    // pending: messages already waiting to be sent (a burst of joins is not
    // allowed to flood the chat).
    async playerJoined(name, { botName = '', pending = 0 } = {}) {
      const w = getSettings().chat.welcome;
      if (!w.message || now() < greetFrom || !canPromote()) return false;
      if (!/^[A-Za-z0-9_]{1,16}$/.test(name) || name.toLowerCase() === botName.toLowerCase()) return false;
      if (pending >= 5) return false;
      const key = name.toLowerCase();
      const last = greeted.get(key);
      if (last !== undefined && now() - last < w.cooldownHours * 3600000) return false;
      greeted.set(key, now());
      if (greeted.size > 5000) for (const [k, t] of greeted) if (now() - t > w.cooldownHours * 3600000) greeted.delete(k);
      await whisper(name, w.message);
      await logger.debug('chat.welcome', `Welcomed ${name}.`);
      return true;
    }
  };
}

module.exports = { createPromoter };
