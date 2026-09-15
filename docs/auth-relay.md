# Browser login relay for a headless Mac

Run Claude, Codex, and Grok Build login on your headless Mac while signing in
using your everyday Mac's browser. The relay sends the browser callback back
through SSH over Tailscale. The original CLI saves its own credentials remotely.

## Quick start

You need Node.js 20 or later on both Macs, the relevant CLI on the headless Mac,
and working SSH access from your everyday Mac to its Tailscale hostname.
On the headless Mac, macOS **System Settings → General → Sharing → Remote Login**
provides ordinary SSH; Tailscale is the network transport. Your tailnet access
rules must allow that connection. Test `ssh youruser@headless-mac` first.

Copy **just `scripts/auth-relay.mjs`** from this checkout to your everyday Mac.
There is no npm install, background service, or separate relay installation
required on the headless Mac. For example, run on your everyday Mac:

```sh
scp youruser@headless-mac:/path/to/cloudcli-fork/scripts/auth-relay.mjs ~/auth-relay.mjs
export CLOUDCLI_AUTH_HOST=youruser@headless-mac

node ~/auth-relay.mjs claude
node ~/auth-relay.mjs codex
node ~/auth-relay.mjs grok
```

Run one login at a time. Each command starts that provider's login remotely,
opens your local browser, waits for completion, and removes its temporary files
and callback tunnels. Keep the terminal open until the CLI reports success.
If Claude displays a code to paste, paste it into this same terminal.

To make the hostname default permanent, add the `export CLOUDCLI_AUTH_HOST=...`
line to your everyday Mac's `~/.zshrc`. You can also use `--host user@hostname`
on each command. SSH config aliases work, including aliases that configure a
nonstandard port, identity file, or jump host.

From a checkout on your everyday Mac, `npm run auth:relay -- claude --host
user@headless-mac` works too. A package installed from this version exposes
`cloudcli-auth claude --host user@headless-mac`.

## Provider behavior

| Provider | Remote command | Authentication return |
| --- | --- | --- |
| Claude | `claude auth login` | Dynamic localhost callback, or paste-code fallback |
| Codex | `codex login` | Localhost callback (normally port 1455) |
| Grok Build | `grok login --oauth` | Dynamic localhost callback |

Codex and Grok also support device-code login:

```sh
node ~/auth-relay.mjs codex --device-auth
node ~/auth-relay.mjs grok --device-auth
```

The relay opens the verification URL locally; enter the displayed code in the
browser. The remote CLI polls for completion, so no callback port is needed.
Codex device login may need enabling in account/workspace settings. See the
[official Codex authentication documentation](https://learn.chatgpt.com/docs/auth).

This command starts a new login session. It does not intercept already-running
CLI sessions or every browser launch on the headless Mac. No system browser
defaults, shell profiles, CLI credential files, or CloudCLI server settings are
changed by the helper. If CloudCLI runs under a different macOS user or custom
credential directory, use that same user/environment for the remote login.

## How it works

1. The local helper starts a private SSH connection and sends its own code to a
   remote Node process. The remote login shell supplies the CLI's normal PATH.
2. That process runs the native login command with a temporary `BROWSER` helper
   and `open`/`xdg-open` shims, scoped to this child process. Printed authorization
   URLs are a fallback for CLIs that bypass browser hooks. Browser hooks take
   priority: Claude prints a manual-code URL before opening a different URL
   for its automatic localhost callback.
3. The local helper checks the provider URL and its `redirect_uri`. It requests
   SSH forwards for the callback's exact loopback port before opening the URL.
   For `localhost`, both IPv4 and IPv6 must bind successfully.
4. The browser sends the original callback over the tunnel. The CLI validates
   OAuth state/PKCE and completes its own token exchange and credential storage.
5. Completion, cancellation, or disconnect closes the CLI, its browser helpers,
   and the SSH connection. A ten-minute limit bounds abandoned sessions.

The relay preserves the complete authorization URL and never changes redirect
URIs or copies token caches. It accepts only the known provider login origins
and forwards only unprivileged loopback callback ports. The temporary opener's
loopback HTTP endpoint requires a random per-session secret. It has no public
or tailnet-facing HTTP listener. SSH host-key verification remains enabled.
Login URLs and provider output appear in the terminal as with native CLI login;
the relay does not persist them. Provider CLIs may maintain their own logs.

Temporary files live under `tmp/cloudcli/` in the working directory on each Mac
and are removed at session end. These contain browser-hook code and the SSH
control socket, not copied credentials. A force-killed process or power failure
can leave a stale temporary directory; after confirming that no relay is
running, remove the stale `ar-*` or `auth-relay-*` directory there.

## Troubleshooting

- **Node not found remotely:** use `--remote-node /opt/homebrew/bin/node` (or
  the actual path from `command -v node` in the remote login shell).
- **CLI not found:** make its executable available on the remote login-shell
  PATH. Installation paths and Node versions may differ between the two Macs.
- **Callback port is busy:** close the other login or local process using that
  port and retry. The relay stops rather than opening a browser against an
  unrelated local listener. Codex/Grok device auth avoids the callback port.
- **SSH forwarding denied:** allow TCP forwarding for your SSH user. This uses
  ordinary OpenSSH over Tailscale; it does not require the Tailscale SSH server
  feature or Tailscale Serve/Funnel.
- **Browser won't open:** run from the Mac desktop session where you are logged
  in. A background SSH session into that Mac may not have GUI access.
- **Long working-directory path:** run from a shorter directory such as your
  home directory. macOS limits Unix socket path lengths.
- **Custom enterprise identity provider:** this version supports the standard
  Claude/Codex/Grok login origins; a custom initial authorization origin needs
  an explicit adapter update. Ordinary SSO redirects inside the browser work.
- **Connection drops:** rerun the command to begin a fresh OAuth session.
- **Claude login succeeds but CloudCLI still reports expired credentials:**
  check that both run as the same user with the same `CLAUDE_CONFIG_DIR`, and
  that the server can access the selected macOS Keychain entry. Callback
  forwarding cannot unlock an inaccessible Keychain for a background service.

## Validation

Run `npm run test:auth-relay`. The tests use fake provider executables and actual
loopback HTTP listeners to exercise browser hooks, printed URLs, callbacks,
paste-code input, rejected requests, cancellation, disconnects, and cleanup.
They also check that both callback forwards complete before the browser opens,
and that a forwarding failure prevents browser launch. Full account sign-in
still requires a human at the everyday Mac's browser.
