# Session mailbox

An MCP server (`cloudcli-session-mailbox`) attached to every live CloudCLI
chat session so an agent can message another live session in the same
project directly — no human relaying text between tabs.

## Tools

- `list_peer_sessions` — other live sessions in the same project (excludes
  yourself and internal/automation sessions). Returns `sessionId`, `title`,
  `provider`, `busy`, `lastActivity`.
- `send_peer_message` — `{ sessionId, message, waitMs? }`. If the recipient
  is idle, this starts a new chat turn with your message. If it's busy, the
  message is injected into its live run when the provider supports mid-run
  injection (Claude today), otherwise it's queued to the recipient's inbox.
  Pass `waitMs` (up to 60000) to wait for a reply.
- `check_peer_inbox` — unread (queued) messages addressed to you; marks them
  read.
- `reply_to_peer` — `{ messageId, message, waitMs? }`, threads a reply back
  to whoever sent the original message.

Caps: 8,000 characters per message, same project only, 20 outbound messages
per session per 5 minutes.

## How delivery works

`send_peer_message` and `reply_to_peer` both go through the same
`startProviderRun` path the chat websocket handler uses
(`server/modules/websocket/services/chat-run-starter.service.ts`):

- If the recipient session has no active run (`chatRunRegistry.isProcessing`
  is false), a fresh run starts with the message as its content — this is
  exactly a synthesized `chat.send` into the recipient's session.
- If the recipient is busy, `startProviderRun` offers the message to that
  provider's `injectFn` (only Claude's mid-run stdin injection today). If
  accepted, the message lands in the live run. Otherwise the message is
  queued to the recipient's in-memory inbox for `check_peer_inbox`.

Injected content is prefixed for the recipient:

```
[Peer message from session "<title>" (<provider>)]
<message>

Reply via reply_to_peer (messageId=<id>) or send_peer_message.
```

The mailbox is in-memory and process-lifetime only (no persistence across a
server restart) — see `server/modules/session-mailbox/session-mailbox.service.ts`.

## Identity

The MCP server has no per-session settings; the same catalog entry is
registered for every provider on server startup
(`providerMcpService.addMcpServerToAllProviders`, mirroring how
`cloudcli-browser` registers itself). Since that registration is shared
across all sessions of a provider, it cannot carry a per-session id by
itself.

Instead, each provider runtime injects `CLOUDCLI_SESSION_ID`,
`CLOUDCLI_PROVIDER`, and `CLOUDCLI_PROJECT_PATH` into the **provider CLI's
own subprocess env** for that run. The CLI process then spawns its
configured MCP servers (including `cloudcli-session-mailbox`) as children,
which inherit that env — the standard MCP config behavior (env is layered
on top of the parent process env, not a full replacement). See:

- `server/claude-sdk.js` (`mapCliOptionsToSDK`)
- `server/grok-cli.js` (`spawnGrok`)
- `server/opencode-cli.js` (`spawnAcpProvider` — covers opencode, kilo,
  cline, and qwencode, which all share this ACP runtime)
- `server/openai-codex.js` (`queryCodex` → `createCodexAppServer`)
- `server/cursor-cli.js` (`spawnCursor` → `runCursorProcess`)
- `server/kimi-cli.js` (`spawnKimi` → `createAcpSession`)
- `server/pi-cli.js` (`spawnPi` → `createPiRpcSession`)

Every provider CloudCLI drives now injects this identity, so
`cloudcli-session-mailbox` works from any of them.

The HTTP bridge (`server/modules/session-mailbox/session-mailbox-mcp.routes.ts`,
mounted at `/api/session-mailbox-mcp`) trusts the `x-session-mailbox-session-id`
header set by the MCP stdio process from its own `CLOUDCLI_SESSION_ID` env —
never a client-suppliable body field — so one session cannot impersonate
another. A shared bearer token (`CLOUDCLI_SESSION_MAILBOX_MCP_TOKEN`,
generated once and stored in `app_config`) authenticates the MCP process to
the backend, the same pattern `cloudcli-browser` uses.

## Agent Relay workers

This branch does not yet contain the Agent Relay lead/worker MCP
(`cloudcli-agent-relay`) or its worker MCP sanitization step — it is being
built in a sibling branch. When it merges, its worker MCP allowlist/stripping
logic should **not** strip `cloudcli-session-mailbox`: workers spawned by
Agent Relay are meant to keep the peer mailbox, unlike the relay-lead-only
tools.
