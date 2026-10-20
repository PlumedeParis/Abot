'use strict';

// Discord side: slash commands (admin + linking), membership revocation,
// periodic reconciliation, and forwarding of logged events to the log channel.

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
const { setStatus } = require('./database');
const { fetchUnsentEvents, markEventsSent, markEventsFailed, pruneEvents } = require('./logging');
const { isAuthorizedAdmin, createConfirmationStore, createAdminActions, SENSITIVE } = require('./admin');
const linking = require('./linking');
const { formatDuration } = require('./limits');

const LEVEL_COLORS = { INFO: 0x3498db, WARNING: 0xf1c40f, ERROR: 0xe74c3c, ADMIN: 0x9b59b6 };
const EPHEMERAL = MessageFlags.Ephemeral;

function buildCommands() {
  const player = (sc, desc) => sc.addStringOption((o) => o.setName('player').setDescription(desc).setRequired(true).setMaxLength(40));
  const kitbot = new SlashCommandBuilder()
    .setName('kitbot')
    .setDescription('KitBot administration')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sc) => sc.setName('status').setDescription('Show bot status'))
    .addSubcommand((sc) => sc.setName('stats').setDescription('Show global statistics'))
    .addSubcommand((sc) =>
      sc
        .setName('player')
        .setDescription('Show a player link and statistics')
        .addStringOption((o) => o.setName('username').setDescription('Minecraft username, @mention or Discord ID').setRequired(true).setMaxLength(40))
    )
    .addSubcommand((sc) => sc.setName('queue').setDescription('Show pending requests'))
    .addSubcommand((sc) => sc.setName('pause').setDescription('Pause kit deliveries'))
    .addSubcommand((sc) => sc.setName('resume').setDescription('Resume kit deliveries'))
    .addSubcommand((sc) =>
      sc
        .setName('maintenance')
        .setDescription('Enable or disable maintenance mode')
        .addBooleanOption((o) => o.setName('enabled').setDescription('true = on, false = off').setRequired(true))
    )
    .addSubcommand((sc) => player(sc.setName('unlink').setDescription('Revoke a player link'), 'Minecraft username, @mention or Discord ID'))
    .addSubcommand((sc) => player(sc.setName('cooldown-reset').setDescription('Reset a player cooldown'), 'Minecraft username, @mention or Discord ID'))
    .addSubcommand((sc) => player(sc.setName('quota-reset').setDescription('Reset a player quota'), 'Minecraft username, @mention or Discord ID'))
    .addSubcommand((sc) => sc.setName('reload').setDescription('Reload non-secret settings'))
    .addSubcommand((sc) => sc.setName('recalibrate').setDescription('Re-detect the kit chests around the bot'))
    .addSubcommand((sc) => sc.setName('logs').setDescription('Show recent events'))
    .addSubcommand((sc) => sc.setName('help').setDescription('List administrator commands'));

  const link = new SlashCommandBuilder()
    .setName('link')
    .setDescription('Link your Minecraft account to use the kit bot')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) => o.setName('minecraft_username').setDescription('Your Minecraft username').setRequired(true).setMinLength(3).setMaxLength(16))
    .addStringOption((o) => o.setName('replace').setDescription('Linked username to replace (only if you have several links)').setMaxLength(16));

  const status = new SlashCommandBuilder().setName('linkstatus').setDescription('Show your linked Minecraft account and limits').setContexts(InteractionContextType.Guild);

  return [kitbot, link, status].map((c) => c.toJSON());
}

const ts = (ms) => (ms ? `<t:${Math.floor(Number(ms) / 1000)}:R>` : 'never');
const clip = (s, n = 1000) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

function eventEmbed(evt) {
  return new EmbedBuilder()
    .setColor(LEVEL_COLORS[evt.level] || 0x95a5a6)
    .setTitle(clip(`${evt.level} · ${evt.type}`, 250))
    .setDescription(clip(evt.message, 4000))
    .setTimestamp(new Date(Number(evt.created_at)));
}

function createDiscordBot({ config, db, logger, checkMembership, onSettingsReloaded = () => {} }) {
  const { secrets } = config;
  let settings = config.settings;
  const getSettings = () => settings;
  const adminCfg = { adminIds: secrets.discord.adminIds, guildId: secrets.discord.guildId };
  const confirmations = createConfirmationStore({ ttlMs: settings.discord.confirmationTimeoutSeconds * 1000 });
  const actions = createAdminActions({
    db,
    logger,
    getSettings,
    onReload: (s) => {
      settings = s;
      onSettingsReloaded(s);
    }
  });

  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
  const intervals = [];
  let connected = false;
  let flushing = false;

  // ---- log channel forwarding ---------------------------------------------
  async function flushLogs() {
    if (flushing || !connected) return;
    flushing = true;
    try {
      const channel = await client.channels.fetch(secrets.discord.logChannelId).catch(() => null);
      if (!channel || !channel.isTextBased()) return;
      for (let i = 0; i < 5; i++) {
        const events = await fetchUnsentEvents(db, 10);
        if (!events.length) break;
        const ids = events.map((e) => e.id);
        try {
          await channel.send({ embeds: events.map(eventEmbed), allowedMentions: { parse: [] } });
          await markEventsSent(db, ids);
        } catch (e) {
          await markEventsFailed(db, ids);
          console.error(`[${new Date().toISOString()}] Could not post to the log channel: ${logger.redact(e.message)}`);
          break;
        }
      }
    } finally {
      flushing = false;
    }
  }

  // ---- membership -----------------------------------------------------------
  async function revokeForLeaver(discordId, why) {
    const revoked = await linking.revokeLinks(db, discordId, why);
    for (const l of revoked) await logger.warn('link.revoked', `Revoked link ${l.mc_username} <-> <@${discordId}>: ${why}.`);
    return revoked;
  }

  // Catches members who left while the bot was offline.
  async function reconcileMembers() {
    const ids = await linking.allActiveDiscordIds(db);
    let revoked = 0;
    for (const id of ids) {
      const m = await checkMembership(id);
      if (m.status === 'not_member') revoked += (await revokeForLeaver(id, 'not a member of the Discord server (reconciliation)')).length;
      else if (m.status === 'unavailable') return; // try again later; never revoke on uncertainty
    }
    if (revoked) await logger.info('link.reconciled', `Membership reconciliation revoked ${revoked} link(s).`);
  }

  // ---- interaction handling -------------------------------------------------
  function adminIdentity(interaction) {
    return { id: interaction.user.id, tag: interaction.user.tag };
  }

  async function denied(interaction, sub) {
    await logger.warn('admin.denied', `Unauthorised /kitbot ${sub} attempt by ${interaction.user.tag} (${interaction.user.id}).`);
    await interaction.reply({ content: 'You are not allowed to use this command.', flags: EPHEMERAL });
  }

  function confirmRow(nonce) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`kitbot:confirm:${nonce}`).setLabel('Confirm').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`kitbot:cancel:${nonce}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    );
  }

  async function runSensitive(admin, action, args) {
    switch (action) {
      case 'unlink': {
        const revoked = await actions.unlink(admin, args.player);
        return revoked.length ? `Revoked ${revoked.length} link(s): ${revoked.map((l) => `\`${l.mc_username}\``).join(', ')}.` : 'No active link found for that player.';
      }
      case 'cooldown-reset':
        return (await actions.cooldownReset(admin, args.player)) ? `Cooldown reset for \`${args.player}\`.` : 'Player not found.';
      case 'quota-reset':
        return (await actions.quotaReset(admin, args.player)) ? `Quota reset for \`${args.player}\`.` : 'Player not found.';
      case 'maintenance':
        await actions.maintenance(admin, args.enabled);
        return `Maintenance mode ${args.enabled ? 'enabled' : 'disabled'}.`;
      default:
        return 'Unknown action.';
    }
  }

  async function handleKitbot(interaction) {
    const sub = interaction.options.getSubcommand();
    if (!isAuthorizedAdmin({ userId: interaction.user.id, guildId: interaction.guildId }, adminCfg)) return denied(interaction, sub);
    const admin = adminIdentity(interaction);

    if (SENSITIVE.has(sub)) {
      const args = sub === 'maintenance' ? { enabled: interaction.options.getBoolean('enabled', true) } : { player: interaction.options.getString('player', true) };
      const nonce = confirmations.create(admin.id, sub, args);
      const what = sub === 'maintenance' ? `turn maintenance mode **${args.enabled ? 'on' : 'off'}**` : `run **${sub}** for \`${clip(args.player, 40)}\``;
      return interaction.reply({ content: `Please confirm: ${what}. This expires in ${settings.discord.confirmationTimeoutSeconds}s.`, components: [confirmRow(nonce)], flags: EPHEMERAL });
    }

    await interaction.deferReply({ flags: EPHEMERAL });
    const embed = new EmbedBuilder().setColor(LEVEL_COLORS.ADMIN).setTimestamp();
    switch (sub) {
      case 'status': {
        const s = await actions.status();
        const mc = s.minecraft?.value;
        const dc = s.discord?.value;
        embed.setTitle('KitBot status').addFields(
          { name: 'Minecraft', value: mc ? `${mc.ready ? '🟢 ready' : mc.connected ? '🟡 connected, not ready' : '🔴 offline'} · updated ${ts(s.minecraft.updatedAt)}` : 'no data', inline: false },
          { name: 'Kit station', value: mc ? (mc.stationReady ? '✅ found' : '❌ not found (see the log channel)') : 'no data', inline: true },
          { name: 'Discord', value: dc ? `${dc.connected ? '🟢 connected' : '🔴 disconnected'} · ping ${dc.ping ?? '?'}ms` : 'no data', inline: true },
          { name: 'Deliveries', value: s.maintenance ? '🛠️ maintenance' : s.paused ? '⏸️ paused' : '▶️ running', inline: true },
          { name: 'Queue', value: `${s.queued} queued · ${s.processing} processing${mc?.currentRequest ? `\nNow: #${mc.currentRequest.id} ${mc.currentRequest.kit} → ${mc.currentRequest.player}` : ''}` },
          { name: 'Recent errors', value: s.recentErrors.length ? clip(s.recentErrors.map((e) => `${ts(e.created_at)} ${e.type}: ${e.message}`).join('\n')) : 'none' }
        );
        break;
      }
      case 'stats': {
        const st = await actions.stats();
        const c = st.counts;
        embed.setTitle('KitBot statistics').addFields(
          { name: 'Total requests', value: String(st.total), inline: true },
          { name: 'Delivered', value: String(c.delivered || 0), inline: true },
          { name: 'Failed', value: String((c.failed || 0) + (c.expired || 0)), inline: true },
          { name: 'Unconfirmed', value: String(c.unconfirmed || 0), inline: true },
          { name: 'Cancelled', value: String(c.cancelled || 0), inline: true },
          { name: 'Pending', value: String((c.queued || 0) + (c.processing || 0)), inline: true },
          { name: 'Most requested kits', value: st.requestedByKit.length ? st.requestedByKit.map((k) => `${k.kit}: ${k.n}`).join('\n') : 'none' }
        );
        break;
      }
      case 'player': {
        const p = await actions.player(interaction.options.getString('username', true));
        if (!p) {
          embed.setTitle('Player not found');
          break;
        }
        const linksText = p.links.length
          ? p.links.map((l) => `\`${l.mc_username}\` · ${l.verification_status} · linked ${ts(l.linked_at)}${l.last_username_change_at ? ` · changed ${ts(l.last_username_change_at)}` : ''}${l.mc_uuid ? `\nUUID ${l.mc_uuid}` : ''}`).join('\n')
          : 'none';
        embed.setTitle('Player').addFields(
          { name: 'Discord', value: `<@${p.discordId}> (${p.discordId})` },
          { name: 'Links', value: clip(linksText) },
          { name: 'Cooldown', value: p.usage.cooldownRemainingMs ? formatDuration(p.usage.cooldownRemainingMs) : 'ready', inline: true },
          { name: 'Quota', value: `${p.usage.quotaUsed}/${p.usage.quotaLimit}`, inline: true },
          { name: 'Requests', value: Object.entries(p.stats.counts).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none' },
          { name: 'History', value: clip(p.history.map((h) => `${ts(h.created_at)} ${h.action} ${h.old_username || ''}${h.new_username ? ` → ${h.new_username}` : ''}`).join('\n') || 'none') }
        );
        break;
      }
      case 'queue': {
        const q = await actions.queue();
        embed.setTitle(`Queue (${q.length})`).setDescription(q.length ? clip(q.map((r, i) => `${i + 1}. #${r.id} **${r.kit}** → \`${r.mc_username}\` · ${r.status}${r.stage ? ` (${r.stage})` : ''} · ${ts(r.created_at)}`).join('\n'), 4000) : 'The queue is empty.');
        break;
      }
      case 'pause':
        await actions.pause(admin);
        embed.setTitle('Deliveries paused').setDescription('New requests are rejected; queued requests wait until /kitbot resume.');
        break;
      case 'resume':
        await actions.resume(admin);
        embed.setTitle('Deliveries resumed');
        break;
      case 'recalibrate':
        await actions.recalibrate(admin);
        embed.setTitle('Recalibration requested').setDescription('When idle, the bot looks for the totem chest on its LEFT, pvp on its RIGHT and grief BEHIND it, from where it stands now. The result appears in the log channel.');
        break;
      case 'reload': {
        const r = await actions.reload(admin);
        embed.setTitle(r.ok ? 'Settings reloaded' : 'Reload rejected').setDescription(r.ok ? 'Non-secret settings were reloaded. Secrets are only read at startup.' : clip(r.errors.join('\n'), 4000));
        break;
      }
      case 'logs': {
        const ev = await actions.logs();
        embed.setTitle('Recent events').setDescription(ev.length ? clip(ev.map((e) => `${ts(e.created_at)} **${e.level}** ${e.type}: ${e.message}`).join('\n'), 4000) : 'No events.');
        break;
      }
      case 'help':
      default:
        embed.setTitle('KitBot admin commands').setDescription(actions.help().map(([c, d]) => `\`${c}\` — ${d}`).join('\n'));
    }
    if (!['pause', 'resume', 'reload', 'recalibrate'].includes(sub)) await logger.admin(`admin.${sub}`, `${admin.tag} (${admin.id}) ran /kitbot ${sub}`);
    return interaction.editReply({ embeds: [embed] });
  }

  async function handleButton(interaction) {
    const [, kind, nonce] = interaction.customId.split(':');
    if (!isAuthorizedAdmin({ userId: interaction.user.id, guildId: interaction.guildId }, adminCfg)) {
      await logger.warn('admin.denied', `Unauthorised confirmation click by ${interaction.user.tag} (${interaction.user.id}).`);
      return interaction.reply({ content: 'You are not allowed to do this.', flags: EPHEMERAL });
    }
    if (kind === 'cancel') {
      confirmations.cancel(nonce, interaction.user.id);
      return interaction.update({ content: 'Cancelled.', components: [] });
    }
    const c = confirmations.consume(nonce, interaction.user.id);
    if (!c.ok) return interaction.update({ content: c.reason === 'not_yours' ? 'Only the administrator who ran the command can confirm it.' : 'This confirmation has expired.', components: [] });
    const result = await runSensitive(adminIdentity(interaction), c.action, c.args);
    return interaction.update({ content: result, components: [] });
  }

  async function handleLink(interaction) {
    if (interaction.guildId !== secrets.discord.guildId) return interaction.reply({ content: 'Use this command in the official Discord server.', flags: EPHEMERAL });
    await interaction.deferReply({ flags: EPHEMERAL });
    const m = await checkMembership(interaction.user.id);
    if (m.status !== 'member') {
      const why = {
        unavailable: 'Membership verification is unavailable right now. Try again in a minute.',
        missing_role: 'You need the required role to link an account.'
      };
      return interaction.editReply(why[m.status] || 'You must be a member of this server to link an account.');
    }
    const name = interaction.options.getString('minecraft_username', true).trim();
    const replace = interaction.options.getString('replace');
    const r = await linking.startLink(db, { discordId: interaction.user.id, mcUsername: name, replaceUsername: replace, settings });
    if (!r.ok) {
      const msgs = {
        invalid_username: 'That is not a valid Minecraft username (3-16 letters, digits or _).',
        taken: 'That Minecraft account is already linked to another Discord account.',
        already_linked: 'That Minecraft account is already linked to you.',
        limit_reached: `You already have ${settings.linking.maxLinksPerDiscord} linked account(s). Use the \`replace\` option to choose which one to change.`,
        change_too_soon: `You can change your linked Minecraft account once every ${settings.linking.usernameChangeCooldownDays} days. Next change possible ${ts(r.retryAt)}.`
      };
      await logger.info('link.refused', `Link request by <@${interaction.user.id}> for ${name} refused: ${r.reason}`);
      return interaction.editReply(msgs[r.reason] || 'Linking is not possible right now.');
    }
    await logger.info('link.code_issued', `Link code issued to <@${interaction.user.id}> for ${name}${r.replacing ? ` (replacing ${r.replacing})` : ''}.`);
    const botName = secrets.minecraft.username || 'the kit bot';
    return interaction.editReply(
      [
        `**Your code: \`${r.code}\`** (single use, expires ${ts(r.expiresAt)}).`,
        `Log in to Minecraft as **${name}** and whisper the bot:`,
        `\`/msg ${botName} ${settings.chat.linkCommand} ${r.code}\``,
        r.replacing ? `This will replace your current link \`${r.replacing}\`.` : '',
        'Never share this code.'
      ]
        .filter(Boolean)
        .join('\n')
    );
  }

  async function handleLinkStatus(interaction) {
    if (interaction.guildId !== secrets.discord.guildId) return interaction.reply({ content: 'Use this command in the official Discord server.', flags: EPHEMERAL });
    const p = await actions.player(interaction.user.id);
    const active = p ? p.links.filter((l) => l.verification_status === 'verified') : [];
    if (!active.length) return interaction.reply({ content: 'You have no linked Minecraft account. Use `/link`.', flags: EPHEMERAL });
    const u = p.usage;
    return interaction.reply({
      content: [
        `Linked: ${active.map((l) => `\`${l.mc_username}\``).join(', ')}`,
        `Cooldown: ${u.cooldownRemainingMs ? formatDuration(u.cooldownRemainingMs) : 'ready'}`,
        `Kits used in the last ${settings.limits.quotaWindowHours}h: ${u.quotaUsed}/${u.quotaLimit}`
      ].join('\n'),
      flags: EPHEMERAL
    });
  }

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'kitbot') return await handleKitbot(interaction);
        if (interaction.commandName === 'link') return await handleLink(interaction);
        if (interaction.commandName === 'linkstatus') return await handleLinkStatus(interaction);
      } else if (interaction.isButton() && interaction.customId.startsWith('kitbot:')) {
        return await handleButton(interaction);
      }
    } catch (e) {
      await logger.error('discord.interaction', `Interaction failed: ${e.message}`);
      const payload = { content: 'Something went wrong. The error was logged.', flags: EPHEMERAL };
      if (interaction.isRepliable()) {
        if (interaction.deferred || interaction.replied) await interaction.editReply({ content: payload.content }).catch(() => {});
        else await interaction.reply(payload).catch(() => {});
      }
    }
  });

  client.on(Events.GuildMemberRemove, async (member) => {
    if (member.guild.id !== secrets.discord.guildId) return;
    try {
      await logger.info('discord.member_left', `${member.user?.tag || member.id} (${member.id}) left the Discord server.`);
      await revokeForLeaver(member.id, 'left the Discord server');
    } catch (e) {
      await logger.error('discord.member_left', `Could not revoke links of ${member.id}: ${e.message}`);
    }
  });

  client.once(Events.ClientReady, async (c) => {
    connected = true;
    await logger.info('discord.connected', `Discord bot connected as ${c.user.tag}.`);
    try {
      const rest = new REST({ version: '10' }).setToken(secrets.discord.token);
      await rest.put(Routes.applicationGuildCommands(c.application.id, secrets.discord.guildId), { body: buildCommands() });
      await logger.info('discord.commands', 'Slash commands registered.');
    } catch (e) {
      await logger.error('discord.commands', `Could not register slash commands: ${e.message}`);
    }
    reconcileMembers().catch((e) => logger.error('link.reconcile', e.message));
    flushLogs().catch(() => {});
  });

  // Discord regularly asks bots to reconnect; that takes about a second and is
  // normal. Only an outage longer than a minute is reported.
  let outageStart = null;
  let outageTimer = null;
  let outageReported = false;
  function connectionLost(what) {
    logger.debug('discord.reconnecting', what);
    if (outageStart) return;
    outageStart = Date.now();
    outageTimer = setTimeout(() => {
      outageReported = true;
      logger.warn('discord.disconnected', 'Lost the connection to Discord for more than a minute; reconnecting.');
    }, 60000);
  }
  function connectionBack() {
    connected = true;
    clearTimeout(outageTimer);
    if (outageReported) logger.info('discord.resumed', `Discord connection restored after ${Math.round((Date.now() - outageStart) / 1000)}s.`);
    else if (outageStart) logger.debug('discord.resumed', 'Discord connection resumed.');
    outageStart = null;
    outageReported = false;
  }
  client.on(Events.ShardDisconnect, () => {
    connected = false;
    connectionLost('Discord gateway disconnected.');
  });
  client.on(Events.ShardReconnecting, () => connectionLost('Reconnecting to the Discord gateway.'));
  client.on(Events.ShardResume, connectionBack);
  client.on(Events.ShardReady, () => {
    if (client.isReady()) connectionBack();
  });
  client.on(Events.Error, (e) => logger.error('discord.error', `Discord client error: ${e.message}`));

  async function heartbeat() {
    await setStatus(db, 'discord', { connected, ping: client.ws.ping >= 0 ? client.ws.ping : null, user: client.user ? client.user.tag : null });
  }

  async function start() {
    intervals.push(setInterval(() => flushLogs().catch(() => {}), settings.discord.logFlushIntervalSeconds * 1000));
    intervals.push(setInterval(() => heartbeat().catch(() => {}), 10000));
    intervals.push(setInterval(() => reconcileMembers().catch((e) => logger.error('link.reconcile', e.message)), settings.discord.reconcileIntervalMinutes * 60000));
    intervals.push(setInterval(() => pruneEvents(db, settings.logging.retentionDays).catch(() => {}), 3600000));
    await client.login(secrets.discord.token);
  }

  async function stop() {
    intervals.forEach(clearInterval);
    await flushLogs().catch(() => {});
    await setStatus(db, 'discord', { connected: false, stoppedAt: Date.now() }).catch(() => {});
    connected = false;
    await client.destroy();
  }

  return { start, stop, flushLogs, client };
}

module.exports = { createDiscordBot, buildCommands, eventEmbed };
