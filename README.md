# Anarchy KitBot — Minecraft Java 1.21.11

An automated kit bot for an anarchy server (set up here for **1b1t.cc**). Players type `!kit totem`, `!kit pvp` or `!kit grief` in Minecraft chat. The bot checks that they are linked to a member of your Discord server, enforces cooldowns and quotas, walks to the kit chest, takes the kit, and hands it to the player. It only says "delivered" once the server reports that the player actually picked the kit up.

- **Minecraft bot:** Node.js + [Mineflayer](https://github.com/PrismarineJS/mineflayer) 4.39.0 (1.21.11 is in its tested versions)
- **Discord bot:** discord.js 14.27.0, slash commands
- **Storage:** PostgreSQL (`DATABASE_URL`) or SQLite (local file)
- **CI / short sessions:** GitHub Actions. **24/7:** a permanent host (VPS or Docker), see [§12](#12-migrate-to-permanent-hosting)

---

## Architecture

```
            Minecraft (1b1t.cc)                               Discord
                   │  chat, /msg, chests, pathfinding            │  slash commands, member events
        ┌──────────▼──────────┐                       ┌──────────▼──────────┐
        │   Minecraft bot     │  live membership      │     Discord bot     │
        │  src/minecraft.js   │──REST check──────────▶│   src/discord.js    │
        │  requests.js (chat) │  (fails closed)       │   admin.js (/kitbot)│
        │  queue.js (worker)  │                       │   /link, /linkstatus│
        │  kits.js (movement) │                       │   log forwarder     │
        └──────────┬──────────┘                       └──────────┬──────────┘
                   │            shared database (database.js)     │
                   └──────────────►  links, codes, history,  ◄────┘
                                     requests (queue), limits,
                                     settings (pause/maintenance),
                                     status heartbeats, events (log outbox)
```

- The two bots never call each other. They share the database: the Discord bot writes `paused` / `maintenance` / reload requests, and the Minecraft bot reads them every 3 seconds. Both write status heartbeats that `/kitbot status` reads.
- **Events outbox:** every log event is written to the `events` table first. The Discord bot posts unsent events to the log channel as embeds and marks them sent. If Discord is down, events wait in the database and are posted when it comes back.
- **Queue:** every accepted request is a row in `requests`. A single worker delivers one kit at a time (one inventory) and starts at most `globalPerMinute` (2) deliveries per rolling minute. Requests survive restarts.
- Run both bots in one process (`npm start`), or separately (`npm run start:minecraft` / `npm run start:discord`) against the same PostgreSQL database.

| File | Responsibility |
|---|---|
| `src/index.js` | Entry point, roles, graceful shutdown |
| `src/config.js` | Loads secrets from env and settings from `config.json` / `KITBOT_CONFIG_JSON`; validation |
| `src/database.js` | SQLite / PostgreSQL adapters, schema migrations |
| `src/logging.js` | Levels INFO / WARNING / ERROR / ADMIN, secret redaction, events outbox |
| `src/minecraft.js` | Connection, `/reg` + `/log`, chat intake, throttled replies, reconnects |
| `src/requests.js` | `!kit` / `!link` parsing and the validate → permission → limits → enqueue pipeline |
| `src/limits.js` | Cooldown, rolling quota, global rate |
| `src/queue.js` | Delivery queue, exactly-once claiming, restart recovery |
| `src/kits.js` | Left / right / backward geometry, chest retrieval, delivery and pickup confirmation |
| `src/linking.js` | Single-use link codes, 30-day username change rule, history |
| `src/membership.js` | Live Discord membership check (REST) |
| `src/discord.js` / `src/admin.js` | Slash commands, confirmations, admin actions, log channel |
| `scripts/` | Config validator, syntax check, bounded supervisor for GitHub Actions |
| `test/` | 103 automated tests (see [§8](#8-run-the-tests)) |

---

## What was verified, and what you must check yourself

**Verified while building this project**
- Mineflayer 4.39.0 lists `1.21.11` in `testedVersions`, and minecraft-data 3.117.0 has the 1.21.11 protocol (protocol 774). All dependency versions are pinned exactly, and each had been released for at least two weeks.
- `test/integration.test.js` runs the real bot against a local fake 1.21.11 server built with minecraft-protocol. It covers `/reg` on first join, `/log` on later joins, chat parsing, the "Unknown kit" reply, linking through a whisper, pause mode and spoofed-whisper rejection.
- Limits, linking, the queue and admin permissions are tested against both SQLite and PostgreSQL (PGlite).

**Not verified (no access from the build environment)**
- The live server **1b1t.cc**: its exact chat format, its login messages, whether `/msg`, `/tpa` and similar commands exist, and its bot rules. The defaults follow common AuthMe / vanilla formats. Run once with `"consoleLevel": "DEBUG"` to see the real messages and adjust the patterns (see [§11](#11-troubleshooting)).

### Server rules (required)
The bot will not start the Minecraft side until you set `"server": { "botsAllowedConfirmed": true }`. Read 1b1t's rules first and confirm that automated accounts and kit bots are allowed. The bot does not bypass anti-bot or anti-cheat systems, and if a kick message matches `server.stopOnKickPattern` ("banned", "bots not allowed", …) it **stops reconnecting**.

### 1b1t.cc specifics
- It is an **offline-mode** (cracked) server with AuthMe-style login: `MINECRAFT_AUTH=offline`.
- **First join:** `/reg <password> <password>`. **Later joins:** `/log <password>`. The bot does this automatically: it reads the server's prompt (`/reg…` or `/login…`) and falls back to a stored "already registered" flag. The password comes **only** from the `MINECRAFT_PASSWORD` secret and is redacted from all logs.
- ⚠️ On a cracked server, anyone who knows the password *is* the bot, including its stash access. Use a long random password, never one that matches or resembles the username. If it has ever been shared, change it first (AuthMe servers usually support `/changepassword <old> <new>`; check that 1b1t does) and store only the new one in the secret.
- On offline-mode servers, Minecraft UUIDs are derived from the username. Identity is therefore proven by the server's login password: only someone logged in as that player can send `!link <code>` from that name.

---

## Commands

**In Minecraft** (public chat or a whisper to the bot):

| Command | Effect |
|---|---|
| `!kit totem` / `!kit pvp` / `!kit grief` | Request a kit (case-insensitive) |
| `!kit <anything else>` | "Unknown kit. Available kits: totem, pvp, grief." |
| `!link ABCD-EFGH` | Finish linking (code from `/link` in Discord) |

Normal chat is ignored. A message counts only if it **starts** with `!kit` / `!link`, the sender is visible in the player list, and it is not a repeat within 5 seconds.

**In Discord (players):** `/link minecraft_username:<name> [replace:<old name>]`, `/linkstatus`

**In Discord (admins):** `/kitbot status | stats | player | queue | pause | resume | maintenance | unlink | cooldown-reset | quota-reset | reload | logs | help`. `unlink`, `cooldown-reset`, `quota-reset` and `maintenance` need a confirmation click from the **same** admin within 60 seconds. Every admin action is logged at the ADMIN level.

## Policies

**Limits** are counted per *Discord account*, so linking several Minecraft accounts does not multiply anyone's allowance:
- **Cooldown:** 10 minutes between *accepted* requests, measured from acceptance and shared by all three kits.
- **Daily quota:** at most 10 counted requests in any rolling 24 hours (`quotaWindowHours`). The next slot opens 24 hours after the oldest counted request.
- **What counts:** requests that are queued, processing, delivered, or **unconfirmed** (the kit left the bot but pickup could not be confirmed). Requests that end as failed, expired or cancelled are **refunded**: they count toward neither the cooldown nor the quota.
- **One pending request** per player, enforced by a unique database index. A request can never create two deliveries.
- **Global capacity:** 2 deliveries may start per rolling minute. Others wait in the queue. Queue size is capped at 20, and requests waiting more than 30 minutes expire (refunded).

**Delivery truthfulness:** `delivered` is written only after the target player picks up every tossed stack (the server's `collect` packet). If the player never comes, the chest is empty, navigation times out or the bot disconnects, the request is `failed` (refunded), the player is told why, untouched kit items go back into the chest, and the error is logged. If the kit was dropped but someone else grabbed it, or nobody picked it up, the request is `unconfirmed` and the player is told to contact staff. It is **never** reported as delivered.

**Linking:**
1. Join the Discord server and run `/link minecraft_username:YourName`. You get an 8-character single-use code, stored hashed, valid for 10 minutes and bound to your Discord ID **and** that username.
2. In Minecraft, as that player, whisper the bot: `/msg <BotName> !link ABCD-EFGH`.
3. The bot re-checks your Discord membership, re-checks that no one else owns the name or UUID, and then saves the link (Discord ID, username, UUID, link date, last change date, status `verified`).

- One Minecraft account per Discord account by default (`linking.maxLinksPerDiscord`).
- **Username change:** run `/link` with the new name. This is allowed once every 30 days, counted from the last time the linked name was set. It is computed from the stored history, so reconnecting, unlinking or rejoining Discord never resets it. Re-linking the *same* name is always allowed. Every link, change and revocation is kept in `username_history`.
- **Leaving Discord:** the bot revokes the link as soon as Discord reports the member left, cancels any queued request, and logs it. A reconciliation every 30 minutes (and at startup) catches anyone who left while the bot was offline. Every kit request also does a **live** membership check. If Discord cannot be reached, the request is **rejected**, never allowed. To regain access, the player rejoins and links again.

---

## Installation

### 1. Create the Discord application and bot
1. Go to <https://discord.com/developers/applications> → **New Application** (for example "KitBot").
2. **Bot** tab → **Reset Token** → copy it. This is `DISCORD_TOKEN`. Never share it.
3. Same tab, **Privileged Gateway Intents** → turn on **Server Members Intent** (required to detect members leaving). Message Content Intent is *not* needed.
4. Turn on **Developer Mode** in your Discord client (User Settings → Advanced). You can now right-click to copy IDs:
   - right-click your server → **Copy Server ID** → `DISCORD_GUILD_ID`
   - create a private text channel `#kitbot-logs`, right-click it → **Copy Channel ID** → `DISCORD_LOG_CHANNEL_ID`

### 2. Invite the bot to the server
Replace `APP_ID` with the Application ID (General Information tab) and open:
```
https://discord.com/oauth2/authorize?client_id=APP_ID&scope=bot%20applications.commands&permissions=19456
```
`19456` = View Channels + Send Messages + Embed Links. In `#kitbot-logs`, make sure the bot's role can view the channel, send messages and embed links. Slash commands are registered to your server automatically each time the bot starts.

### 3. Configure administrator permissions
- Right-click each admin → **Copy User ID**, then put the IDs comma-separated in `DISCORD_ADMIN_IDS` (for example `123456789012345678,234567890123456789`).
- `/kitbot` is hidden from members without the Discord *Administrator* permission. To show it to a moderator role: Server Settings → Integrations → KitBot → `/kitbot`.
- **The allowlist is what actually protects the commands.** Every `/kitbot` command and confirmation button is checked server-side: the user must be in `DISCORD_ADMIN_IDS` *and* the command must come from `DISCORD_GUILD_ID`. Changing Discord's command permissions or calling the API directly does not get around this.
- Optional: set `linking.requiredRoleId` to require a role (for example "Verified") in addition to membership.

### 4. Create and configure the GitHub repository
Make the repository **private**. On public repositories, workflow logs and artifacts are visible to others.
```bash
git clone https://github.com/<you>/<repo>.git kitbot && cd kitbot
# (this project's files are already in the repository)
npm ci
cp .env.example .env               # local secrets, ignored by git
cp config.example.json config.json # local settings, ignored by git
```

### 5. Add GitHub Secrets
Repository → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Example / notes |
|---|---|
| `MINECRAFT_HOST` | `1b1t.cc` |
| `MINECRAFT_PORT` | `25565` |
| `MINECRAFT_USERNAME` | the bot account's in-game name |
| `MINECRAFT_AUTH` | `offline` |
| `MINECRAFT_PASSWORD` | the `/reg` / `/log` password (change it first, see above) |
| `DISCORD_TOKEN` | from step 1 |
| `DISCORD_GUILD_ID` | from step 1 |
| `DISCORD_LOG_CHANNEL_ID` | from step 1 |
| `DISCORD_ADMIN_IDS` | from step 3 |
| `DATABASE_URL` | from step 7 (required on GitHub-hosted runners) |
| `KITBOT_CONFIG_JSON` | your filled-in `config.json`, base64-encoded (see below) |

Your kit coordinates are stash coordinates on an anarchy server. Keep them out of git: `config.json` is ignored and is passed as a secret instead:
```bash
node scripts/validate-config.js config.json   # must say "valid"
base64 -w0 config.json                        # macOS: base64 -i config.json
```
Paste the output as `KITBOT_CONFIG_JSON`. Update the secret whenever you change `config.json`.

### 6. Configure the TOTEM, PVP and GRIEF kit locations
Build the station in game: a spot where the bot stands ("home"), with the **totem** chest to its **left**, the **pvp** chest to its **right**, and the **grief** chest **behind** it. Then edit `config.json`:

1. Stand on the home block and press **F3**. Copy the integer `Block:` X Y Z and the direction under `Facing:` (`north`, `south`, `east` or `west`):
   ```json
   "navigation": { "home": { "x": 1200, "y": 70, "z": -3400, "facing": "north" } }
   ```
   (Example numbers only. Use your own. `"yawDegrees"` with the F3 yaw is accepted instead of `facing`.)
2. For each kit, either set `distance` (blocks from home in the kit's direction; the bot computes the spot from `facing`) or give explicit `standAt` coordinates:
   ```json
   "totem": { "direction": "left",  "distance": 3, "standAt": null, ... }
   "pvp":   { "direction": "right", "distance": 3, ... }
   "grief": { "direction": "backward", "standAt": { "x": 1200, "y": 70, "z": -3396 }, ... }
   ```
   Facing north, *left* is west (−X), *right* is east (+X) and *backward* is south (+Z).
3. For each kit, look at its chest. F3 shows `Targeted Block: X Y Z`. Put that in `retrieval.container`. It must be within 4.5 blocks of where the bot stands.
4. List what one kit contains in `retrieval.items`. With the default `{ "nameRegex": "shulker_box$", "count": 1 }`, the bot takes **one shulker box of any colour** per delivery, so fill each chest with pre-filled shulker boxes. For loose items use exact names, for example `{ "name": "totem_of_undying", "count": 4 }`.
5. Choose the **delivery method**. It depends on your server, so test it in game:
   - `"drop"` (default, needs no plugin): the bot walks to `delivery.dropoff`, waits up to 60 seconds for the player to come within 4 blocks, tosses the kit and waits for the pickup. Players must reach the drop-off point, so tell them where it is (or use a public spot).
   - `"teleport"`: only if the server has a working teleport-request plugin. For example, the bot teleports to the player:
     ```json
     "delivery": { "method": "teleport", "commands": ["/tpa {player}"], "afterCommands": [],
                   "instructions": "Accept my teleport request to receive your {kit} kit." }
     ```
     Or the player teleports to the bot. The player is asked to `/tpa` to the bot, and the bot accepts when it sees the request message (match it to the server's exact text):
     ```json
     "delivery": { "method": "teleport", "acceptRequest": { "pattern": "^(?<username>\\w{1,16}) has requested to teleport to you", "command": "/tpaccept {player}" },
                   "instructions": "Type /tpa <BotName> now to receive your {kit} kit." }
     ```
   - `retrieval.method: "command"` exists for servers with a real kit command. Leave it unused unless your server has one.
6. Movement safety: digging, block placing and parkour are **off** by default, so the bot never breaks or builds in your base. `timeoutMs` (per kit) caps each trip.
7. Validate: `npm run validate-config`.

### 7. Create and configure the database
- **PostgreSQL (required for GitHub-hosted runners):** create a free database at any hosted PostgreSQL provider (for example Neon or Supabase), copy its connection string including `?sslmode=require`, and save it as `DATABASE_URL`:
  `postgresql://user:password@host/dbname?sslmode=require`
  Tables are created automatically on first start. There is nothing to run by hand.
- **SQLite (local PC / VPS):** leave `DATABASE_URL` empty. The database is created at `SQLITE_PATH` (default `./data/kitbot.db`). Back up that file.

### 8. Run the tests
```bash
npm ci
npm run check                    # syntax check
npm run validate-config:example  # example settings structure
npm test                         # 103 tests, about 2–3 minutes
```
The tests cover cooldowns (shared across kits), the rolling quota, refunds, the global 2-per-minute limit, one-pending-request races, restart persistence, linking (single-use codes, takeover protection, 30-day changes, history), access revocation when a member leaves, fail-closed Discord outages, admin permissions (non-admins, other guilds, forged confirmations), the guarantee that failed or unconfirmed deliveries are never reported as successful, secret redaction, and a real-protocol run against a fake 1.21.11 server. The `ci.yml` workflow runs all of this on every push.

### 9. Start the bot
Locally or on a VPS (with `.env` and `config.json` filled in):
```bash
npm start                  # both bots
npm run start:minecraft    # only Minecraft
npm run start:discord      # only Discord
```
On GitHub Actions: **Actions → "Run KitBot (bounded session)" → Run workflow**, then choose the duration (up to 340 minutes), the role and the runner. The job installs dependencies, checks the secrets, validates the settings, runs the bot under `scripts/supervise.js` (which restarts it after a crash, up to 5 times), shuts it down cleanly before the time limit, and uploads the console log as an artifact. Only one copy can run at a time.

Stop the bot with Ctrl+C or SIGTERM (or cancel the workflow). It finishes or aborts the current delivery, records its state, logs the shutdown and disconnects cleanly.

### 10. Inspect logs
- **Discord:** `#kitbot-logs` gets embeds (blue INFO, yellow WARNING, red ERROR, purple ADMIN, all timestamped) for startup and shutdown, Minecraft and Discord connections, links, unlinks, members leaving, accepted, rejected and queued requests, delivery start, completion and failure, cooldown and quota violations, username changes, maintenance and admin actions, and errors and reconnects.
- **`/kitbot logs`** (last 15 events), **`/kitbot status`** (connections, queue, recent errors).
- **Console:** one line per event. Set `"logging": { "consoleLevel": "DEBUG" }` to also print every server chat line (useful for tuning patterns; never sent to Discord).
- **GitHub Actions:** the job log, or the `kitbot-log-<run id>` artifact (kept 7 days).
- **systemd:** `journalctl -u kitbot -f`. **Docker:** `docker compose logs -f kitbot`.

Tokens, passwords, database credentials and `/reg` / `/log` arguments are redacted from every log line.

### 11. Troubleshooting

| Symptom | What to do |
|---|---|
| `ECONNREFUSED` / `ETIMEDOUT` | Check `MINECRAFT_HOST` / `MINECRAFT_PORT`. The bot retries with backoff (5 s → 5 min). |
| Kicked: unsupported version / outdated client | Set `MINECRAFT_VERSION` to a version the server accepts (it must be supported by Mineflayer 4.39.0). |
| Stuck after connecting, never "ready" | The login prompt or success message did not match. Set `consoleLevel` to `DEBUG`, read the server's real text, and adjust `auth.*Pattern` (case-insensitive regex). |
| "the server rejected the login password" | Wrong `MINECRAFT_PASSWORD`, or the account was registered with another password. |
| Bot ignores `!kit` | The chat format does not match `chat.patterns`. Use DEBUG to see lines such as `Steve » !kit totem` and add an anchored pattern: `"^(?<username>[A-Za-z0-9_]{1,16}) » (?<message>.+)$"`. |
| Players get no reply | Check that `chat.replyCommand` (`/msg {player} {message}`) exists on the server. |
| Kicked for spam | Increase `chat.minDelayMs` (for example to 3000). |
| "kit container is out of reach" / "no container at the kit location" | Fix `retrieval.container` or `standAt`. The bot must stand within 4.5 blocks of the chest. |
| "could not reach … within 60s" | Path blocked. Clear it, adjust `standAt`, or raise `timeoutMs`. |
| Every request: "Discord verification is temporarily unavailable" | Wrong `DISCORD_TOKEN` / `DISCORD_GUILD_ID`, the bot is not in the server, or Discord is down. By design the bot then refuses requests. |
| Members who left keep access | Server Members Intent is off (step 1.3). |
| `/kitbot` missing | The bot was invited without `applications.commands`, or registration failed (see the log channel). Re-invite with the URL from step 2. |
| Log channel silent | Channel ID, or the bot's View / Send / Embed permissions in that channel. Events are kept and posted once fixed. |
| GitHub run fails "DATABASE_URL is required" | Add it (step 7). GitHub runners lose all files after the job. |

**Recovery after failures (automatic):**
- On a Minecraft disconnect, the delivery in progress is aborted. If the kit had not yet left the bot, the request is re-queued (once). If the kit had already been dropped, the request is marked `unconfirmed`. The bot then reconnects with backoff.
- After a crash or restart, requests left in `processing` are recovered the same way. Queued requests resume, cooldowns and quotas are unchanged (they live in the database), and unsent log events are posted.
- When Discord comes back, the gateway resumes, missed member removals are reconciled, and buffered events are posted.

**Recovery (manual):**
1. `/kitbot status` and `/kitbot logs` show what failed.
2. `/kitbot pause`, fix the problem in game (restock, clear the path), then `/kitbot resume`.
3. If a player was hurt by an `unconfirmed` delivery, `/kitbot cooldown-reset` / `/kitbot quota-reset` (with confirmation).
4. For a GitHub run that stopped, run the workflow again. For a VPS, `sudo systemctl restart kitbot`.

### 12. Migrate to permanent hosting

**What GitHub Actions can and cannot do.** CI (`ci.yml`) is exactly what Actions is for. `bot.yml` runs the bot for *one bounded session* (maximum 6 hours per job on GitHub-hosted runners) that you start by hand. It does not re-trigger itself and has no schedule, so it is **not** 24/7 hosting, and there is no attempt to keep free runners alive. Also check GitHub's terms for Actions: running a long-lived game bot on GitHub-hosted runners may not be an allowed use. The supported 24/7 options are below. Alternatively, register a machine you own as a **self-hosted runner** and choose `self-hosted` as the runner input; the job limit is then much longer, but a permanent host is still simpler.

**Option A: Linux VPS with systemd** (any provider; 1 vCPU and 1 GB RAM is enough)
```bash
sudo apt-get update && sudo apt-get install -y git curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
sudo useradd --system --create-home --home-dir /opt/kitbot kitbot
sudo -u kitbot git clone https://github.com/<you>/<repo>.git /opt/kitbot/app   # or copy the files
cd /opt/kitbot/app && sudo -u kitbot npm ci --omit=dev
sudo -u kitbot cp .env.example .env && sudo -u kitbot cp config.example.json config.json
sudo -u kitbot nano .env && sudo -u kitbot nano config.json
sudo -u kitbot node scripts/validate-config.js
sudo sed -i 's#/opt/kitbot#/opt/kitbot/app#g' deploy/kitbot.service
sudo cp deploy/kitbot.service /etc/systemd/system/kitbot.service
sudo systemctl daemon-reload && sudo systemctl enable --now kitbot
journalctl -u kitbot -f
```
SQLite (`./data/kitbot.db`) is fine on a VPS. Keep using the same `DATABASE_URL` if you already ran on GitHub with PostgreSQL, so links, cooldowns and quotas carry over. To update: `git pull && npm ci --omit=dev && sudo systemctl restart kitbot`.

**Option B: Docker Compose** (bot plus its own PostgreSQL)
```bash
cp .env.example .env            # fill in, including POSTGRES_PASSWORD
cp config.example.json config.json
docker compose up -d --build
docker compose logs -f kitbot
```

**Option C: a container platform.** Build the `Dockerfile`, set the same environment variables (use `KITBOT_CONFIG_JSON` for settings and a hosted `DATABASE_URL`), and run a single instance. Never run two instances at once: the database enforces one pending request per player, but two bots would compete for the same account.

---

## Everything you must configure yourself
1. Confirm in 1b1t's rules that bots are allowed, then set `server.botsAllowedConfirmed: true`.
2. The bot's Minecraft account name (`MINECRAFT_USERNAME`) and a **new, strong** `MINECRAFT_PASSWORD`.
3. The Discord application, token, Server Members Intent, invite, server ID, log channel ID and admin IDs.
4. A PostgreSQL `DATABASE_URL` (for GitHub-hosted runs) or a host with a disk for SQLite.
5. In game: the home spot, the three chests (totem left, pvp right, grief behind), stocked kits (one pre-filled shulker box per delivery by default), and a reachable drop-off point. Then their coordinates in `config.json`.
6. The delivery method that really works on 1b1t (`drop` by default; `teleport` only if a tpa plugin exists).
7. Check with DEBUG logging that `chat.patterns`, `chat.replyCommand` and the `auth.*Pattern` values match 1b1t's real messages.
8. `KITBOT_CONFIG_JSON` (base64 of `config.json`) as a GitHub Secret, updated whenever you change settings.
9. Restock the chests regularly. When a chest is empty, players get an "out of stock" message, the request is refunded, and the ERROR in the log channel tells you which kit.

## Configuration reference (`config.json`)
| Key | Default | Meaning |
|---|---|---|
| `server.botsAllowedConfirmed` | `false` | Must be `true` to run the Minecraft bot |
| `server.version` | `1.21.11` | Protocol version (`MINECRAFT_VERSION` overrides it) |
| `server.stopOnKickPattern` | ban / bots-not-allowed | Kick messages that stop reconnecting |
| `auth.*` | `/reg {password} {password}`, `/log {password}` | Login commands and the regexes for the server's replies |
| `auth.postLoginCommands` | `[]` | Commands after login (for example to leave a lobby) |
| `chat.patterns` | vanilla `<name> msg` + common whisper formats | Anchored regexes with `username` and `message` groups |
| `chat.replyCommand` | `/msg {player} {message}` | How the bot answers players |
| `chat.minDelayMs` | `1500` | Minimum gap between outgoing chat messages |
| `limits.cooldownMinutes` / `dailyQuota` / `quotaWindowHours` | `10` / `10` / `24` | Per-player limits |
| `limits.globalPerMinute` / `maxQueueSize` / `maxQueueWaitMinutes` / `maxAttempts` | `2` / `20` / `30` / `2` | Queue limits |
| `linking.maxLinksPerDiscord` / `codeTtlMinutes` / `usernameChangeCooldownDays` | `1` / `10` / `30` | Linking rules |
| `linking.requiredRoleId` | `null` | Optional Discord role required to use the bot |
| `navigation.home` | — | `{x, y, z, facing}` |
| `navigation.allowDigging` / `allowPlacing` / `allowParkour` | `false` | Movement permissions |
| `delivery.*` | `drop` | Default delivery. Override per kit with `kits.<name>.delivery` |
| `kits.<name>` | — | `direction`, `distance` or `standAt`, `timeoutMs`, `retrieval{method, container, items}` |
| `logging.retentionDays` / `consoleLevel` | `30` / `INFO` | Event retention; console verbosity (`DEBUG` shows chat lines) |

`/kitbot reload` re-reads these settings (from `config.json` or `KITBOT_CONFIG_JSON`), validates them, and applies them to both bots. Invalid settings are rejected and the old ones stay. Secrets are read only at startup and are never shown.

## Security notes
- Secrets live only in environment variables or GitHub Secrets. `.env` and `config.json` are git-ignored, and CI fails if either is committed.
- All SQL uses bound parameters. Usernames are checked against `^[A-Za-z0-9_]{3,16}$`, kit names against a fixed list, and outgoing chat has control characters, `§` and newlines removed and is cut to 256 characters.
- Chat patterns must be anchored at `^`. Senders must be in the player list. A player typing a fake "X whispers: …" in public chat is still attributed to themselves.
- `npm audit` reports one moderate advisory in `uuid` (missing bounds check when a caller supplies a buffer), pulled in by minecraft-protocol's account-login libraries (`yggdrasil` for Mojang, `prismarine-auth` / `@azure/msal-node` for Microsoft). With `MINECRAFT_AUTH=offline` those login paths are not used. Upgrade Mineflayer once a release with fixed dependencies is out.

## License
MIT
