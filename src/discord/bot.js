'use strict';

// The Discord bot: /link, /linkstatus and the /kitbot admin commands; posts
// the logged events to #kitbot-logs and delivery reports to #delivered-kits;
// removes the links of members who leave the server.

const {
  Client,
  GatewayIntentBits,
  Events,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  InteractionContextType,
  REST,
  Routes
} = require('discord.js');
const { setStatus } = require('../db');
const { loadSettings, KIT_NAMES } = require('../config');
const { unsentEvents, markSent, markFailed, pruneEvents } = require('../log');
const { isAdmin, createConfirmations, createAdminActions, SENSITIVE } = require('./admin');
const linking = require('../linking');
const bans = require('../bans');
const { formatDuration } = require('../limits');

const COLORS = { INFO: 0x3498db, WARNING: 0xf1c40f, ERROR: 0xe74c3c, ADMIN: 0x9b59b6, DEBUG: 0x95a5a6 };
const PRIVATE = MessageFlags.Ephemeral;
const ts = (ms) => (ms ? `<t:${Math.floor(Number(ms) / 1000)}:R>` : 'never');
const clip = (s, n = 1000) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

function buildCommands() {
  const target = (sc) => sc.addStringOption((o) => o.setName('player').setDescription('Minecraft name, @mention or Discord ID').setRequired(true).setMaxLength(40));
  const kitbot = new SlashCommandBuilder()
    .setName('kitbot')
    .setDescription('VoidKits administration')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sc) => sc.setName('status').setDescription('Bot status'))
    .addSubcommand((sc) => sc.setName('stats').setDescription('Statistics'))
    .addSubcommand((sc) => target(sc.setName('player').setDescription('A player link, limits and history')))
    .addSubcommand((sc) => sc.setName('queue').setDescription('Waiting orders'))
    .addSubcommand((sc) => sc.setName('pause').setDescription('Pause deliveries'))
    .addSubcommand((sc) => sc.setName('resume').setDescription('Resume deliveries'))
    .addSubcommand((sc) =>
      sc
        .setName('maintenance')
        .setDescription('Maintenance mode')
        .addBooleanOption((o) => o.setName('enabled').setDescription('on or off').setRequired(true))
    )
    .addSubcommand((sc) => target(sc.setName('unlink').setDescription('Remove a player link')))
    .addSubcommand((sc) => target(sc.setName('cooldown-reset').setDescription('Reset a player cooldown')))
    .addSubcommand((sc) => target(sc.setName('quota-reset').setDescription('Reset a player quota')))
    .addSubcommand((sc) => target(sc.setName('ban').setDescription('Ban a player from the kit bot')).addStringOption((o) => o.setName('reason').setDescription('Why').setMaxLength(200)))
    .addSubcommand((sc) => target(sc.setName('unban').setDescription('Lift a ban')))
    .addSubcommand((sc) => sc.setName('bans').setDescription('Banned players'))
    .addSubcommand((sc) => sc.setName('stock').setDescription('Kits left in each chest'))
    .addSubcommand((sc) => sc.setName('recalibrate').setDescription('Look for the kit chests again'))
    .addSubcommand((sc) =>
      sc
        .setName('say')
        .setDescription('Say something in the Minecraft chat')
        .addStringOption((o) => o.setName('message').setDescription('Text (no commands)').setRequired(true).setMaxLength(240))
    )
    .addSubcommand((sc) => sc.setName('reload').setDescription('Reload the settings'))
    .addSubcommand((sc) => sc.setName('logs').setDescription('Recent events'))
    .addSubcommand((sc) => sc.setName('help').setDescription('Administrator commands'));
  const link = new SlashCommandBuilder()
    .setName('link')
    .setDescription('Link your Minecraft account to order kits')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) => o.setName('minecraft_username').setDescription('Your Minecraft name').setRequired(true).setMinLength(3).setMaxLength(16))
    .addStringOption((o) => o.setName('replace').setDescription('Your linked name to replace (only with several links)').setMaxLength(16));
  const status = new SlashCommandBuilder().setName('linkstatus').setDescription('Your linked account and limits').setContexts(InteractionContextType.Guild);
  return [kitbot, link, status].map((c) => c.toJSON());
}

function eventEmbed(e) {
  const [title, ...rest] = String(e.message).split('\n');
  const embed = new EmbedBuilder().setTimestamp(new Date(Number(e.created_at)));
  if (e.type === 'delivery.report') return embed.setColor(title.startsWith('✅') ? 0x2ecc71 : 0xe67e22).setTitle(clip(title, 250)).setDescription(clip(rest.join('\n') || '—', 4000));
  return embed.setColor(COLORS[e.level] || COLORS.DEBUG).setTitle(clip(`${e.level} · ${e.type}`, 250)).setDescription(clip(e.message, 4000));
}

function createDiscordBot({ config, db, logger, checkMembership, botName }) {
  const { secrets } = config;
  let settings = config.settings;
  const getSettings = () => settings;
  const adminCfg = { adminIds: secrets.discord.adminIds, guildId: secrets.discord.guildId };
  const confirmations = createConfirmations({ ttlMs: settings.discord.confirmationTimeoutSeconds * 1000 });
  const actions = createAdminActions({ db, logger, getSettings });
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
  const timers = [];
  let connected = false;
  let flushing = false;

  // ---- logs -> Discord --------------------------------------------------------
  async function flushLogs() {
    if (flushing || !connected) return;
    flushing = true;
    try {
      const logs = await client.channels.fetch(secrets.discord.logChannelId).catch(() => null);
      if (!logs?.isTextBased()) return;
      const dId = secrets.discord.deliveriesChannelId;
      const deliveries = dId && dId !== secrets.discord.logChannelId ? await client.channels.fetch(dId).catch(() => null) : null;
      for (let round = 0; round < 5; round++) {
        const events = await unsentEvents(db, 10);
        if (!events.length) return;
        const groups = [
          [deliveries?.isTextBased() ? deliveries : logs, events.filter((e) => e.type === 'delivery.report')],
          [logs, events.filter((e) => e.type !== 'delivery.report')]
        ];
        for (const [channel, group] of groups) {
          if (!group.length) continue;
          const ids = group.map((e) => e.id);
          try {
            await channel.send({ embeds: group.map(eventEmbed), allowedMentions: { parse: [] } });
            await markSent(db, ids);
          } catch (e) {
            await markFailed(db, ids);
            console.error(`[${new Date().toISOString()}] Could not post to Discord: ${logger.redact(e.message)}`);
            return;
          }
        }
      }
    } finally {
      flushing = false;
    }
  }

  // ---- members who left ---------------------------------------------------------
  async function revoke(discordId, why) {
    const revoked = await linking.revokeLinks(db, discordId, why);
    for (const l of revoked) await logger.warn('link.revoked', `Unlinked ${l.mc_username} from <@${discordId}>: ${why}.`);
    return revoked.length;
  }

  // Catches members who left while the bot was offline. Never revokes on doubt.
  async function reconcile() {
    let n = 0;
    for (const id of await linking.allActiveDiscordIds(db)) {
      const m = await checkMembership(id);
      if (m.status === 'unavailable') return;
      if (m.status === 'not_member') n += await revoke(id, 'not in the Discord server any more');
    }
    if (n) await logger.info('link.reconciled', `Removed ${n} link(s) of people who left the Discord server.`);
  }

  // ---- /kitbot -----------------------------------------------------------------------
  const who = (i) => ({ id: i.user.id, tag: i.user.tag });

  async function runConfirmed(admin, action, args) {
    switch (action) {
      case 'unlink': {
        const r = await actions.unlink(admin, args.player);
        return r.length ? `Removed ${r.length} link(s): ${r.map((l) => `\`${l.mc_username}\``).join(', ')}.` : 'No active link found.';
      }
      case 'cooldown-reset':
        return (await actions.cooldownReset(admin, args.player)) ? `Cooldown reset for \`${args.player}\`.` : 'Player not found.';
      case 'quota-reset':
        return (await actions.quotaReset(admin, args.player)) ? `Quota reset for \`${args.player}\`.` : 'Player not found.';
      case 'maintenance':
        await actions.maintenance(admin, args.enabled);
        return `Maintenance mode ${args.enabled ? 'on' : 'off'}.`;
      default:
        return 'Unknown action.';
    }
  }

  async function kitbot(i) {
    const sub = i.options.getSubcommand();
    if (!isAdmin({ userId: i.user.id, guildId: i.guildId }, adminCfg)) {
      await logger.warn('admin.denied', `${i.user.tag} (${i.user.id}) tried /kitbot ${sub} without permission.`);
      return i.reply({ content: 'You are not allowed to use this command.', flags: PRIVATE });
    }
    const admin = who(i);
    if (SENSITIVE.has(sub)) {
      const args = sub === 'maintenance' ? { enabled: i.options.getBoolean('enabled', true) } : { player: i.options.getString('player', true) };
      const nonce = confirmations.create(admin.id, sub, args);
      const what = sub === 'maintenance' ? `turn maintenance **${args.enabled ? 'on' : 'off'}**` : `run **${sub}** for \`${clip(args.player, 40)}\``;
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`kitbot:confirm:${nonce}`).setLabel('Confirm').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`kitbot:cancel:${nonce}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
      );
      return i.reply({ content: `Confirm: ${what}? (expires in ${settings.discord.confirmationTimeoutSeconds}s)`, components: [row], flags: PRIVATE });
    }

    await i.deferReply({ flags: PRIVATE });
    const e = new EmbedBuilder().setColor(COLORS.ADMIN).setTimestamp();
    switch (sub) {
      case 'status': {
        const s = await actions.status();
        const mc = s.minecraft?.value;
        const dc = s.discord?.value;
        const state = !mc ? 'no data' : mc.ready ? '🟢 in game, reading the chat' : mc.connected ? '🟡 connected, logging in' : '🔴 offline';
        e.setTitle('VoidKits status').addFields(
          { name: 'Minecraft', value: `${state}${mc ? ` · ${mc.online} player(s) online · updated ${ts(s.minecraft.updatedAt)}` : ''}` },
          { name: 'Kit chests', value: mc ? (mc.stationReady ? '✅ found' : '❌ not found (see #kitbot-logs)') : 'no data', inline: true },
          { name: 'Discord', value: dc ? `${dc.connected ? '🟢' : '🔴'} ping ${dc.ping ?? '?'}ms` : 'no data', inline: true },
          { name: 'Deliveries', value: s.maintenance ? '🛠️ maintenance' : s.paused ? '⏸️ paused' : '▶️ running', inline: true },
          { name: 'Queue', value: `${s.queued} waiting · ${s.processing} in progress${mc?.currentRequest ? `\nNow: #${mc.currentRequest.id} ${mc.currentRequest.kit} → ${mc.currentRequest.player}` : ''}` },
          { name: 'Recent errors', value: s.errors.length ? clip(s.errors.map((x) => `${ts(x.created_at)} ${x.type}: ${x.message}`).join('\n')) : 'none' }
        );
        break;
      }
      case 'stats': {
        const st = await actions.stats();
        const c = st.counts;
        e.setTitle('VoidKits statistics').addFields(
          { name: 'Orders', value: String(st.total), inline: true },
          { name: 'Delivered', value: String(c.delivered || 0), inline: true },
          { name: 'Failed / expired', value: String((c.failed || 0) + (c.expired || 0)), inline: true },
          { name: 'Unconfirmed', value: String(c.unconfirmed || 0), inline: true },
          { name: 'Cancelled', value: String(c.cancelled || 0), inline: true },
          { name: 'Waiting', value: String((c.queued || 0) + (c.processing || 0)), inline: true },
          { name: 'By kit', value: st.byKit.map((k) => `${k.kit}: ${k.n}`).join('\n') || 'none' }
        );
        break;
      }
      case 'player': {
        const p = await actions.player(i.options.getString('player', true));
        if (!p) {
          e.setTitle('Player not found');
          break;
        }
        e.setTitle('Player').addFields(
          { name: 'Discord', value: `<@${p.discordId}> (${p.discordId})` },
          { name: 'Links', value: clip(p.links.map((l) => `\`${l.mc_username}\` · ${l.verification_status} · ${ts(l.linked_at)}`).join('\n') || 'none') },
          { name: 'Cooldown', value: p.usage.cooldownRemainingMs ? formatDuration(p.usage.cooldownRemainingMs) : 'ready', inline: true },
          { name: 'Quota', value: `${p.usage.quotaUsed}/${p.usage.quotaLimit}`, inline: true },
          { name: 'Orders', value: Object.entries(p.stats).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none' },
          { name: 'History', value: clip(p.history.map((h) => `${ts(h.created_at)} ${h.action} ${h.old_username || ''}${h.new_username ? ` → ${h.new_username}` : ''}`).join('\n') || 'none') }
        );
        break;
      }
      case 'queue': {
        const q = await actions.queue();
        e.setTitle(`Queue (${q.length})`).setDescription(q.length ? clip(q.map((r, n) => `${n + 1}. #${r.id} **${r.kit}** → \`${r.mc_username}\` · ${r.status}${r.stage ? ` (${r.stage})` : ''} · ${ts(r.created_at)}`).join('\n'), 4000) : 'Empty.');
        break;
      }
      case 'pause':
        await actions.pause(admin);
        e.setTitle('Deliveries paused').setDescription('New orders are refused until /kitbot resume.');
        break;
      case 'resume':
        await actions.resume(admin);
        e.setTitle('Deliveries resumed');
        break;
      case 'ban': {
        const r = await actions.ban(admin, i.options.getString('player', true), i.options.getString('reason'));
        e.setTitle(r.ok ? 'Banned' : 'Not banned').setDescription(
          r.ok ? `${[r.name && `\`${r.name}\``, r.discordId && `<@${r.discordId}>`].filter(Boolean).join(' / ')} can no longer order kits or link accounts.` : { invalid: 'Not a Minecraft name, @mention or Discord ID.', already_banned: 'Already banned.' }[r.reason]
        );
        break;
      }
      case 'unban': {
        const n = await actions.unban(admin, i.options.getString('player', true));
        e.setTitle(n ? 'Ban lifted' : 'No ban found');
        break;
      }
      case 'bans': {
        const list = await actions.bans();
        e.setTitle(`Banned (${list.length})`).setDescription(
          list.length ? clip(list.map((b) => `• ${[b.mc_username && `\`${b.mc_username}\``, b.discord_id && `<@${b.discord_id}>`].filter(Boolean).join(' / ')} · ${ts(b.created_at)}${b.reason ? ` · ${b.reason}` : ''}`).join('\n'), 4000) : 'Nobody.'
        );
        break;
      }
      case 'stock': {
        const { stock, lowThreshold } = await actions.stock();
        e.setTitle('Kit stock').setDescription(
          KIT_NAMES.map((k) => {
            const st = stock[k];
            if (!st) return `**${k}**: not counted yet (counted when the bot next opens the chest)`;
            return `${st.left === 0 ? '🔴' : st.left <= lowThreshold ? '🟠' : '🟢'} **${k}**: ${st.left} left · ${ts(st.checkedAt)}`;
          }).join('\n')
        );
        break;
      }
      case 'recalibrate':
        await actions.recalibrate(admin);
        e.setTitle('Looking for the kit chests').setDescription('When idle, the bot looks for TOTEM on its left, PVP on its right and GRIEF in front. The result appears in #kitbot-logs.');
        break;
      case 'say': {
        const r = await actions.say(admin, i.options.getString('message', true));
        e.setTitle(r.ok ? 'Message queued' : 'Message refused').setDescription(r.ok ? `> ${r.message}` : { empty: 'Empty message.', command: 'Commands (/...) are not allowed.', too_long: 'Too long.' }[r.reason]);
        break;
      }
      case 'reload': {
        const r = await actions.reload(admin);
        if (r.ok) settings = loadSettings().settings;
        e.setTitle(r.ok ? 'Settings reloaded' : 'Reload refused').setDescription(r.ok ? 'Secrets are only read at startup.' : clip(r.errors.join('\n'), 4000));
        break;
      }
      case 'logs': {
        const ev = await actions.logs();
        e.setTitle('Recent events').setDescription(ev.length ? clip(ev.map((x) => `${ts(x.created_at)} **${x.level}** ${x.type}: ${x.message}`).join('\n'), 4000) : 'None.');
        break;
      }
      default:
        e.setTitle('Administrator commands').setDescription(actions.help().map(([c, d]) => `\`${c}\` — ${d}`).join('\n'));
    }
    return i.editReply({ embeds: [e] });
  }

  async function button(i) {
    const [, kind, nonce] = i.customId.split(':');
    if (!isAdmin({ userId: i.user.id, guildId: i.guildId }, adminCfg)) return i.reply({ content: 'You are not allowed to do this.', flags: PRIVATE });
    if (kind === 'cancel') {
      confirmations.cancel(nonce, i.user.id);
      return i.update({ content: 'Cancelled.', components: [] });
    }
    const c = confirmations.consume(nonce, i.user.id);
    if (!c.ok) return i.update({ content: c.reason === 'not_yours' ? 'Only the administrator who ran the command can confirm it.' : 'This confirmation expired.', components: [] });
    return i.update({ content: await runConfirmed(who(i), c.action, c.args), components: [] });
  }

  // ---- /link and /linkstatus --------------------------------------------------------------
  async function link(i) {
    if (i.guildId !== secrets.discord.guildId) return i.reply({ content: 'Use this command in the official Discord server.', flags: PRIVATE });
    await i.deferReply({ flags: PRIVATE });
    const m = await checkMembership(i.user.id);
    if (m.status !== 'member') {
      return i.editReply(
        { unavailable: 'Discord membership cannot be checked right now. Try again in a minute.', missing_role: 'You need the required role to link an account.' }[m.status] || 'You must be in this server to link an account.'
      );
    }
    const name = i.options.getString('minecraft_username', true).trim();
    if (await bans.findBan(db, { name, discordId: i.user.id })) return i.editReply('You are banned from the kit bot.');
    const r = await linking.startLink(db, { discordId: i.user.id, name, replaceName: i.options.getString('replace'), settings });
    if (!r.ok) {
      await logger.info('link.refused', `/link by <@${i.user.id}> for ${name} refused: ${r.reason}.`);
      return i.editReply(
        {
          invalid_username: 'That is not a valid Minecraft name (3-16 letters, digits or _).',
          taken: 'That Minecraft account is already linked to someone else.',
          already_linked: 'That Minecraft account is already linked to you.',
          limit_reached: `You already have ${settings.linking.maxLinksPerDiscord} linked account(s). Use the \`replace\` option.`,
          change_too_soon: `You can change your linked account once every ${settings.linking.usernameChangeCooldownDays} days. Next change ${ts(r.retryAt)}.`
        }[r.reason] || 'Linking is not possible right now.'
      );
    }
    await logger.info('link.code', `Link code given to <@${i.user.id}> for ${name}${r.replacing ? ` (replacing ${r.replacing})` : ''}.`);
    return i.editReply(
      [
        `**Your code: \`${r.code}\`** (single use, expires ${ts(r.expiresAt)})`,
        `Join the Minecraft server as **${name}** and whisper the bot:`,
        `\`/msg ${botName} ${settings.chat.linkCommand} ${r.code}\``,
        r.replacing ? `This replaces your link to \`${r.replacing}\`.` : '',
        `Then order with \`${settings.chat.kitCommand} totem\`, \`${settings.chat.kitCommand} pvp\` or \`${settings.chat.kitCommand} grief\` in the game chat.`,
        'Never share this code.'
      ]
        .filter(Boolean)
        .join('\n')
    );
  }

  async function linkStatus(i) {
    if (i.guildId !== secrets.discord.guildId) return i.reply({ content: 'Use this command in the official Discord server.', flags: PRIVATE });
    const p = await actions.player(i.user.id);
    const active = p ? p.links.filter((l) => l.verification_status === 'verified') : [];
    if (!active.length) return i.reply({ content: 'You have no linked Minecraft account. Use `/link`.', flags: PRIVATE });
    const u = p.usage;
    return i.reply({
      content: [
        `Linked: ${active.map((l) => `\`${l.mc_username}\``).join(', ')}`,
        `Cooldown: ${u.cooldownRemainingMs ? formatDuration(u.cooldownRemainingMs) : 'ready'}`,
        `Kits in the last ${settings.limits.quotaWindowHours}h: ${u.quotaUsed}/${u.quotaLimit}`
      ].join('\n'),
      flags: PRIVATE
    });
  }

  client.on(Events.InteractionCreate, async (i) => {
    try {
      if (i.isChatInputCommand()) {
        if (i.commandName === 'kitbot') return await kitbot(i);
        if (i.commandName === 'link') return await link(i);
        if (i.commandName === 'linkstatus') return await linkStatus(i);
      } else if (i.isButton() && i.customId.startsWith('kitbot:')) return await button(i);
    } catch (e) {
      await logger.error('discord.interaction', `Command failed: ${e.message}`);
      if (!i.isRepliable()) return;
      if (i.deferred || i.replied) await i.editReply({ content: 'Something went wrong; it was logged.' }).catch(() => {});
      else await i.reply({ content: 'Something went wrong; it was logged.', flags: PRIVATE }).catch(() => {});
    }
  });

  client.on(Events.GuildMemberRemove, (member) => {
    if (member.guild.id !== secrets.discord.guildId) return;
    revoke(member.id, 'left the Discord server').catch((e) => logger.error('link.revoke', `Could not unlink ${member.id}: ${e.message}`));
  });

  client.once(Events.ClientReady, async (c) => {
    connected = true;
    await logger.info('discord.connected', `Discord bot connected as ${c.user.tag}.`);
    try {
      await new REST({ version: '10' }).setToken(secrets.discord.token).put(Routes.applicationGuildCommands(c.application.id, secrets.discord.guildId), { body: buildCommands() });
    } catch (e) {
      await logger.error('discord.commands', `Could not register the slash commands: ${e.message}`);
    }
    reconcile().catch((e) => logger.error('link.reconcile', e.message));
    flushLogs().catch(() => {});
  });

  // Short gateway reconnects are normal; only outages over a minute are reported.
  let outage = null;
  client.on(Events.ShardDisconnect, () => {
    connected = false;
    if (!outage) outage = { at: Date.now(), timer: setTimeout(() => logger.warn('discord.disconnected', 'Lost the Discord connection for over a minute; reconnecting.'), 60000) };
  });
  client.on(Events.ShardResume, () => {
    connected = true;
    if (outage) clearTimeout(outage.timer);
    outage = null;
  });
  client.on(Events.ShardReady, () => {
    if (!client.isReady()) return;
    connected = true;
    if (outage) clearTimeout(outage.timer);
    outage = null;
  });
  client.on(Events.Error, (e) => logger.error('discord.error', `Discord error: ${e.message}`));

  async function start() {
    timers.push(setInterval(() => flushLogs().catch(() => {}), settings.discord.logFlushIntervalSeconds * 1000));
    timers.push(setInterval(() => setStatus(db, 'discord', { connected, ping: client.ws.ping >= 0 ? client.ws.ping : null }).catch(() => {}), 10000));
    timers.push(setInterval(() => reconcile().catch((e) => logger.error('link.reconcile', e.message)), settings.discord.reconcileIntervalMinutes * 60000));
    timers.push(setInterval(() => pruneEvents(db, settings.logging.retentionDays).catch(() => {}), 3600000));
    await client.login(secrets.discord.token);
  }

  async function stop() {
    timers.forEach(clearInterval);
    await flushLogs().catch(() => {});
    await setStatus(db, 'discord', { connected: false, stoppedAt: Date.now() }).catch(() => {});
    connected = false;
    await client.destroy();
  }

  return { start, stop, flushLogs, client };
}

module.exports = { createDiscordBot, buildCommands, eventEmbed };
