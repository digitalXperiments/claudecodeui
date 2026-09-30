# Running CloudCLI always-on (headless box)

Bots are only as always-on as the machine they run on. **A laptop that sleeps is not
always-on**: a sleeping Mac runs no cron wake-ups, no watchers, no Telegram polling and no
approvals. Bot Runtime v2 therefore supports one deployment shape for 24/7 work: run the **whole
CloudCLI server** on a machine that never sleeps (a Mac mini under a desk, or a small cloud VM),
and point your browser, the Endurance app or your phone at it.

The per-bot `runtime_json.backend` setting accepts only `local` (run on the machine that hosts the
server). `docker` and `ssh` are **not implemented**; asking for them returns
`not implemented — run the whole server on a remote box (see HEADLESS.md)`. The remote box is the
server, not a per-bot sandbox.

## 1. Build and run

```bash
npm ci
npm run build          # client + dist-server
node dist-server/server/cli.js
```

The server runs from `dist-server`, not from source. **After you change server code, rebuild
before you restart**, or the running service keeps the old behaviour.

Useful environment variables (set them in the service definition, not in a shell profile):

| Variable | Purpose |
|---|---|
| `SERVER_PORT` | Port (default 3001). |
| `HOST` | Bind address. Default `0.0.0.0`. On a box behind a tunnel or reverse proxy set `127.0.0.1`. |
| `DATABASE_PATH` | SQLite file. Default `~/.cloudcli/auth.db`. Back this file up. |
| `CLOUDCLI_BOTS_HOME` | Bot homes root. Default `~/.cloudcli/bots`. Each bot gets `<root>/<bot_id>/home/`. |
| `CLOUDCLI_PUBLIC_URL` | Public base URL for signed approval links (section 4). |
| `CLOUDCLI_SECRETS_KEY` | Base64 32-byte master key for the secrets vault. A headless box has no login keychain, so set this from a real secret manager or keep the key file on an encrypted volume. Lose it and every stored secret (including per-bot credentials) is unreadable. |
| `CLOUDCLI_BOT_HANDOFF_TIMEOUT_MINUTES` | How long `bot__request_handoff` waits for you (default 30). |
| `CLOUDCLI_BOT_GATEWAY_API_TIMEOUT_MS` | Longest blocking gateway call (default 2,100,000 ms). Keep it above the handoff wait. |

Provider logins live on the box too. Sign in to every CLI you route bots to, as the same OS user
that runs the service (`claude auth login`, the Codex, Grok and other CLIs). An expired login shows up
as an auth failure; add a `routing.fallback` provider so the bot fails over instead of stopping.

## 2. macOS: LaunchAgent

Install a per-user LaunchAgent so the server starts at login and restarts if it dies. This is
the shape the current workstation uses (`~/Library/LaunchAgents/com.claudecodeui.server.plist`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.cloudcli.server</string>
  <key>ProgramArguments</key>
  <array>
    <!-- caffeinate keeps the Mac awake for as long as the server runs: -i no idle sleep, -s no
         system sleep while on AC power. The server becomes caffeinate's child. -->
    <string>/usr/bin/caffeinate</string><string>-i</string><string>-s</string>
    <string>/ABSOLUTE/PATH/TO/node</string>
    <string>/ABSOLUTE/PATH/TO/cloudcli/dist-server/server/cli.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Users/YOU/.local/bin</string>
    <key>HOME</key><string>/Users/YOU</string>
    <key>HOST</key><string>127.0.0.1</string>
    <key>CLOUDCLI_PUBLIC_URL</key><string>https://bots.example.com</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/YOU/Library/Logs/cloudcli/stdout.log</string>
  <key>StandardErrorPath</key><string>/Users/YOU/Library/Logs/cloudcli/stderr.log</string>
  <key>WorkingDirectory</key><string>/Users/YOU</string>
</dict>
</plist>
```

```bash
mkdir -p ~/Library/Logs/cloudcli
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cloudcli.server.plist
launchctl kickstart -k gui/$(id -u)/com.cloudcli.server     # restart after a rebuild
launchctl print gui/$(id -u)/com.cloudcli.server | head      # state and last exit code
```

If the app looks down but the port answers, `KeepAlive` may be crash-looping: read
`stderr.log` first.

A LaunchAgent only runs while the user is logged in. On a dedicated headless Mac enable
automatic login for that user (this is not possible while FileVault is on; decide which protection
matters more on that machine) so it comes back after a power cut.

### Keep the Mac awake

Pick one or combine:

- **`caffeinate` in the service** (above). Cheapest, travels with the service.
  `caffeinate -s` only holds off system sleep on AC power.
- **Power settings.** On a desktop Mac: `sudo pmset -a sleep 0` (never system sleep) and, if the machine
  should survive a power cut, `sudo pmset -a autorestart 1`. A laptop that must run with the lid closed
  also needs `sudo pmset -a disablesleep 1` and AC power; a laptop is still a poor server.
- **Scheduled wake** as a safety net: `sudo pmset repeat wakeorpoweron MTWRFSU 06:00:00`.

Verify rather than assume:

```bash
pmset -g assertions     # PreventUserIdleSystemSleep / PreventSystemSleep should be 1
curl -s -H "Authorization: Bearer <token>" http://127.0.0.1:3001/api/bots/runtime/host
# {"host":{"platform":"darwin","sleepPrevented":true,"publicUrlConfigured":true,"uptime":86400,"hostUptime":864000}}
```

`sleepPrevented` is `null` when it cannot be determined (not macOS, or `pmset` failed). Read
`null` as unknown, not as awake.

### macOS privacy (TCC)

A background service cannot answer a permission prompt, and on managed Macs MDM can block the
grant outright. Keep bot homes and project checkouts out of `Documents`, `Desktop` and `Downloads`.
The default bot home (`~/.cloudcli/bots`) is safe.

## 3. Linux / cloud VM

Same server, different supervisor. A systemd unit is enough:

```ini
[Unit]
Description=CloudCLI
After=network-online.target

[Service]
User=cloudcli
WorkingDirectory=/home/cloudcli
Environment=HOST=127.0.0.1 SERVER_PORT=3001 CLOUDCLI_PUBLIC_URL=https://bots.example.com
EnvironmentFile=/etc/cloudcli/secrets.env        # CLOUDCLI_SECRETS_KEY=..., chmod 600
ExecStart=/usr/bin/node /opt/cloudcli/dist-server/server/cli.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

A VM does not sleep, so no keep-awake step is needed. The browser runtime installs Chromium on
demand (`POST /api/browser-use/runtime/install`); on a minimal image install Playwright's system
libraries first (`npx playwright install-deps chromium`).

## 4. Reaching it: public URL and approvals

- **Telegram needs no inbound URL.** Inbound messages use `getUpdates` long polling started by
  the server (channel config `inbound: true`). Outbound messages are plain API calls. A box behind
  NAT with no open ports can still chat with you over Telegram.
- **Approval buttons are signed links.** Slack, email and push cards link to
  `GET <base>/api/bot-actions/<token>`: an HMAC-signed, expiring (24 h) link for one action on one
  interrupt, which needs no login. The base URL must be reachable from your phone, so set
  `CLOUDCLI_PUBLIC_URL` (or the `bots.public_base_url` app setting, which wins). Without it links
  point at `http://localhost:<port>` and only work on the box itself. `runtime/host` reports
  `publicUrlConfigured`.
- **Human handoff** (`bot__request_handoff`) raises a `bot_handoff` card with Done and Cancel, sent
  through the same channels. A browser the bot hands over is driven from the Browser panel of the
  CloudCLI UI, so the UI must be reachable too.

Ways to expose it, safest first: a Cloudflare or Tailscale tunnel to `127.0.0.1:3001`; a reverse
proxy (nginx/Caddy) with TLS in front of `127.0.0.1:3001`. If a tunnel points at nginx, which points at
the app, a 502 means nginx is down, not the app.

## 5. Security notes

- **Do not expose port 3001 directly.** The default bind is `0.0.0.0`. Set `HOST=127.0.0.1` and put TLS
  and (ideally) an identity-aware tunnel in front. The app's own login protects the UI and API; the
  signed action links and the bot-gateway/browser MCP endpoints are the only unauthenticated
  routes (link tokens are HMAC-signed and expire; the MCP endpoints require a server-held token and a
  per-run binding secret).
- **Run as a dedicated, unprivileged OS user.** Bots execute provider CLIs with that user's
  permissions. Give the user only the repos and files the bots need; global-scope bots work in
  their own `~/.cloudcli/bots/<id>/home`, project bots in their project.
- **Secrets** live in the encrypted vault. Per-bot credentials are secrets with scope `profile`,
  ref `bot:<botId>` and name `<SERVER>__<ENV_OR_HEADER>`; the API lists names only. Protect
  `CLOUDCLI_SECRETS_KEY` and the database file together with backups: one without the other is useless,
  both together are everything.
- **The action gate is the safety floor, not the network.** Send, publish, delete, purchase,
  credential and prod-change calls ask by default; keep that, and use per-bot budgets
  (daily spend, daily actions, wakes per hour) as the kill switch when nobody is watching.
- **Provider failover never repeats a write.** A failed run that already executed a write-class tool
  is not retried on another provider.
- **The bot's browser profile holds live logins** (`<botHome>/browser-profile`). Treat the bot
  home like a password manager: encrypted disk, restricted permissions, excluded from sync.
  Delete the folder to sign the bot out everywhere.
- **Back up** `~/.cloudcli` (database, bot homes, key file). Bot homes hold learned skills.

## 6. What is not here

- No Docker or SSH per-bot backend (see the top of this page).
- No automatic failover of the *server*: one box, restarted by the supervisor. Run it on a machine
  with a UPS or a provider with live migration if downtime matters.
- Handoff waits are bounded by `CLOUDCLI_BOT_HANDOFF_TIMEOUT_MINUTES` and by the kernel's episode
  limit; a handoff cancelled because the run ended reports `run_ended`.
