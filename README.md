# VoidKits — kit bot for 1b1t.cc

Players type `!kit totem`, `!kit pvp` or `!kit grief` in the Minecraft chat. VoidKits checks that the player is linked to a member of your Discord server, applies cooldowns and quotas, takes a shulker box from the right chest, sends the player `/tpa`, throws the kit when they arrive, and counts it as delivered only after the server reports that this player picked it up. Then it uses `/kill` to respawn at its bed and walks back to its spot.

- **Minecraft:** Node.js + [Mineflayer](https://github.com/PrismarineJS/mineflayer) 4.39 (Minecraft 1.21.11), account **VoidKits** (cracked server: `/reg` on the first join, `/log` after)
- **Discord:** discord.js 14 with slash commands
- **Storage:** SQLite, kept between GitHub Actions runs in the Actions cache, or PostgreSQL (`DATABASE_URL`)

## How the bot reads the chat

1b1t.cc writes chat lines like `OG 1b1ter Steve » !kit pvp`. The bot does not depend on one chat format:

| Chat arrives as | How the sender is found |
|---|---|
| Player chat packet (vanilla chat, `/msg`) | The UUID in the packet, matched against the tab list. The text is exactly what the player typed. |
| Profileless chat packet (some plugins) | The display name in the packet. |
| System message (most chat plugins, 1b1t.cc) | The name right before the first separator (`»`, `:`, `>`, `\|`, `→`, ...). The server writes that part, so a player cannot fake it. |

The sender must be in the tab list. Lines relayed from Discord (`[1b1tDiscord] ...`) are ignored, because their authors are not in game. Whispers (`Steve whispers: ...`, `[Steve -> me] ...`, `From Steve: ...`) work too.

If a line mentions `!kit` but the bot cannot tell who sent it, `#kitbot-logs` gets a `chat.unreadable` warning with the raw line. Every command the bot does understand shows as `chat.command Steve: !kit pvp`.

## Setup (about 15 minutes)

**1. Discord bot**
1. <https://discord.com/developers/applications> → **New Application** → **Bot** tab → **Reset Token** → copy it.
2. Same tab: turn on **Server Members Intent** → **Save**.
3. Invite it (replace `APPLICATION_ID`, from **General Information**):
   `https://discord.com/oauth2/authorize?client_id=APPLICATION_ID&scope=bot%20applications.commands&permissions=19472`

**2. GitHub secret:** repository **Settings → Secrets and variables → Actions → New repository secret** → `DISCORD_TOKEN`.

**3. The kit station in Minecraft.** VoidKits is a new account, so it starts at the world spawn:
1. Join 1b1t.cc with your own launcher as **VoidKits** and register with `/reg <password> <password>` (or `/log <password>` if the account is already registered), using the bot's password (`MINECRAFT_PASSWORD` in `.github/workflows/bot.yml` or your secret).
2. Go to your base. **Sleep in a bed** there, within about 30 blocks of the bot's spot, with a clear path. After each delivery the bot uses `/kill` to respawn at this bed.
3. Stand on the bot's block, facing north, south, east or west, and place chests in straight lines from it (1-6 blocks, at foot level or one up or down):
   ```
           [GRIEF]
   [TOTEM]   BOT   [PVP]
             bed
   ```
   TOTEM on your **left**, PVP on your **right**, GRIEF **in front**. Keep the side behind you free of chests, barrels and shulker boxes.
4. Fill each chest with **filled shulker boxes**: one shulker box per delivery.
5. **Log out while standing on that block.** If the bot is turned another way when it logs in, it works out its orientation from the chests.

**4. Start:** **Actions → Run VoidKits → Run workflow**, tick the box confirming that the server rules allow bots, then **Run workflow**. A run lasts at most 340 minutes. Enter a larger total (e.g. `1000`) and it continues in new runs automatically.

`#kitbot-logs` then shows `Logged in. Reading the chat for !kit` and `Kit chests found`. If a chest is missing, the message says which one. Fix it in game and run `/kitbot recalibrate`.

**Players:** `/link minecraft_username:<name>` in Discord, then in game `/msg VoidKits !link <code>`, then `!kit totem`, `!kit pvp` or `!kit grief`, and accept the bot's `/tpa` with `/tpaccept`.

## Rules

- **Cooldown** 10 minutes between kits, **quota** 10 kits per 24 hours, one order at a time per Discord account. Linking several Minecraft accounts does not give more.
- Orders that fail before the kit leaves the bot (player offline, `/tpa` not accepted, empty chest, bot disconnected) **do not count**. An order where the kit was thrown but the pickup was not confirmed counts and is reported as *unconfirmed*.
- A player who leaves the Discord server loses their link immediately (also checked every 30 minutes and before each delivery).
- A player can change their linked Minecraft name once every 30 days.

## Discord commands

| Command | Who | What |
|---|---|---|
| `/link minecraft_username:<name>` | everyone | Get a code to link your account |
| `/linkstatus` | everyone | Your link, cooldown and quota |
| `/kitbot status` · `stats` · `queue` · `logs` · `stock` · `help` | admins | Information |
| `/kitbot player <player>` | admins | A player's link, limits and history |
| `/kitbot pause` · `resume` | admins | Stop or restart deliveries |
| `/kitbot maintenance <on/off>` | admins | Maintenance mode (asks to confirm) |
| `/kitbot unlink` · `cooldown-reset` · `quota-reset <player>` | admins | Asks to confirm |
| `/kitbot ban <player> [reason]` · `unban` · `bans` | admins | Ban from the kit bot (also bans their Discord account) |
| `/kitbot recalibrate` | admins | Look for the kit chests again |
| `/kitbot say <message>` | admins | Say something in the Minecraft chat (no commands) |
| `/kitbot reload` | admins | Reload the settings |

Admins are the server owner, or the IDs in `DISCORD_ADMIN_IDS`. The check is done by the bot itself, not only by Discord permissions.

## Settings

Everything has a default. To change something, put the changed part in a repository secret `KITBOT_CONFIG_JSON` (JSON, or base64 of it), or in `config.json` on your own host. See `config.example.json` and the defaults in `src/config.js`. Common changes:

| Setting | Default | Meaning |
|---|---|---|
| `chat.replyCommand` | `/msg {player} {message}` | How the bot answers players |
| `chat.deliveryAnnouncement` | public line after each delivery | `""` turns it off |
| `chat.ignorePattern` | lines starting with `[...discord...]` | Lines that are never commands |
| `chat.patterns` | `[]` | Extra chat formats: regexes with `(?<username>...)` and `(?<message>...)`, starting with `^` |
| `limits.*` | see Rules | Cooldown, quota, queue size, global rate |
| `navigation.home` | detected | `{ "x", "y", "z", "facing": "north" }` to set the bot's spot by hand |
| `kits.<kit>.container` / `standAt` | detected | Chest coordinates set by hand |
| `kits.<kit>.items` | one shulker box | What one kit is |
| `delivery.method` | `teleport` | `teleport` (`/tpa`) or `drop` (players come to the bot) |
| `logging.consoleLevel` | `INFO` | `DEBUG` prints every chat line the bot receives |

Environment variables (GitHub secrets): `DISCORD_TOKEN` (required), `MINECRAFT_HOST` (`1b1t.cc`), `MINECRAFT_PORT`, `MINECRAFT_USERNAME` (`VoidKits`), `MINECRAFT_PASSWORD` (default set in the workflow), `MINECRAFT_AUTH` (`offline`), `MINECRAFT_VERSION` (`1.21.11`), `DISCORD_GUILD_ID`, `DISCORD_LOG_CHANNEL_ID`, `DISCORD_DELIVERIES_CHANNEL_ID`, `DISCORD_ADMIN_IDS`, `DATABASE_URL`, `KITBOT_CONFIG_JSON`.

## Troubleshooting

| In `#kitbot-logs` | What to do |
|---|---|
| Nothing about `chat.command` when players type `!kit` | Look for `chat.unreadable` lines: they show the raw chat line. Add its format to `chat.patterns`. With `logging.consoleLevel: "DEBUG"`, every chat line is printed in the Actions log. |
| `No chat message at all for 15 minutes` | The bot is not in the world (lobby, queue, or death screen). |
| `Kit chests not found (pvp)` | Fix that chest (side, distance, height) and run `/kitbot recalibrate`. |
| `cannot walk back` / `still ... blocks from home after /kill` | The bot's bed is missing or too far: sleep in a bed next to the base as VoidKits. |
| `could not open the pvp chest after 8 clicks ... the server said: ...` | The bot clicks 5 times, then twice turns away, clicks in the air and clicks the chest again, then waits 10 seconds and clicks a last time. If all fail, a protection or anti-cheat plugin is probably blocking the click: the server's message is included. `Opened the pvp chest after N clicks` only means it needed several tries. |
| `Login failed: the server refused the password` | Wrong `MINECRAFT_PASSWORD` for this account. |

## Running elsewhere

- **Docker:** `cp .env.example .env` (fill it in), then `docker compose up -d --build`. This uses PostgreSQL.
- **VPS:** `npm ci --omit=dev`, then `node src/index.js` (systemd unit in `deploy/kitbot.service`).
- **Separate processes:** `node src/index.js minecraft` and `node src/index.js discord`, sharing one database.

## Development

```
npm ci
npm test          # chat detection, linking, limits, queue, delivery, real-protocol test
npm run check     # syntax
```

`test/integration.test.js` runs the real bot against a local Minecraft 1.21.11 server. That server sends the 1b1t chat format and real player chat packets.
