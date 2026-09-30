# Tool Gateway enforcement by provider

`getGatewayEnforcement(provider, { builtinToolGate })` (enforcement.ts) returns the level below. Keep this table in sync.

- **enforced**: a run started with `strictMcpSelection` can reach MCP tools only through `cloudcli-tool-gateway`, AND every
  built-in tool (Bash/Read/Write/Edit/WebFetch ...) is decided by the built-in tool gate. Only Claude with
  `options.builtinToolGate` set qualifies: `getGatewayEnforcement('claude', { builtinToolGate: true })`. Without the
  built-in gate Claude is advisory.
- **advisory**: the gateway is attached and the gate works for calls that go through it, but the provider can still
  load its own MCP servers (native config, cloud connectors), so a call may bypass the gate. Trust review must show
  "advisory" for these, and the operator should remove other MCP servers from that provider.

The gateway learns the calling session from `CLOUDCLI_SESSION_ID`, falling back to `CLOUDCLI_LEAD_SESSION_ID`.

| Provider | Level | Strict selection | Session id reaches the stdio child | Notes |
|---|---|---|---|---|
| claude | enforced with the built-in gate, else advisory | `claude-sdk.js` filters loaded servers to `options.mcpServers` and passes `--strict-mcp-config` (so user/project config and claude.ai connectors are not merged back in). `allowedTools` is `mcp__cloudcli-tool-gateway__*`. | Yes: `CLOUDCLI_SESSION_ID` on the SDK subprocess env, plus `CLOUDCLI_LEAD_SESSION_ID` stamped on each stdio entry. | Built-in tools are governed by `createBuiltinToolGate` (gate/builtin-tool-gate.ts): with `options.botGatewayStrict` and `options.builtinToolGate`, `claude-sdk.js` installs it as `canUseTool`, forces `permissionMode: 'default'`, strips non-gateway `allowedTools`, sets `settingSources: []` (so user/project allow rules and hooks cannot pre-approve), and blocks live switches to bypass. Order: MCP pass-through, hard denylist (~/.claude*, ~/.codex, ~/.grok, ~/.cursor, ~/.config, ~/.cloudcli except the bot home, *.db, keychain, sqlite3, env dumps, curl/wget/nc to localhost, MCP launchers), seat classification (worker), then the Action Gate (`server: 'builtin'`). "Always allow" is never stored for built-in tools. Build the options with `buildGatewayRunGuards(section, { appSessionId, episodeId, runId, projectPath })` after `gatewaySessions.bind`. The per-binding secret (`CLOUDCLI_BOT_GATEWAY_BINDING_SECRET`) is stamped onto the gateway stdio entry only. |
| opencode | advisory (MCP strict, but built-in tools are ungated and no binding secret is stamped) | `opencode-cli.js` already honours `strictMcpSelection`: only the requested catalog servers go into ACP `session/new` and the catalog-wide attach is skipped. ACP does not read opencode's own `mcp` config. | `CLOUDCLI_SESSION_ID` on the spawn env; `CLOUDCLI_LEAD_SESSION_ID` stamped on the ACP stdio env. | The gateway must be bound to `opencode` in the catalog (`registerBotGatewayMcp` does this). Promote to enforced once it has a built-in gate and stamps the binding secret. |
| codex | advisory | No per-run MCP selection on the app-server path; it loads the user's `config.toml` MCP servers. | `CLOUDCLI_SESSION_ID` is on the app-server env, but Codex forwards only named variables to MCP children, so the catalog entry declares `envVars` for both ids. | Enforcing needs `mcp_servers` overridden to the gateway only (as relay workers do with `{}`); not done. |
| grok | advisory | Only the requested catalog servers are attached over ACP, but grok also loads MCP from its own config and grok.com connectors. | Both ids are stamped on the ACP stdio env. | Strictness would need a gateway-only managed `GROK_HOME`. |
| kimi | advisory | `session/new` is sent with `mcpServers: []`; Kimi reads its own config. | `CLOUDCLI_SESSION_ID` on spawn env. | The gateway is reachable only via Kimi's native config projection. |
| cursor | advisory | `cursor-agent` has no flag to disable `~/.cursor/mcp.json` / project `mcp.json`. | `CLOUDCLI_SESSION_ID` on spawn env. | Tool allow-lists are prompt advice only. |
| kilo, cline, qwencode | advisory | Share the OpenCode ACP runtime, but their native-config behaviour is unverified. | As opencode. | Promote to enforced once verified. |
| pi, omp | advisory | No MCP selection in their runners; native config only. | `CLOUDCLI_SESSION_ID` on spawn env. | |
| antigravity | advisory | The MCP facet reports zero scopes, so the gateway cannot even be projected. | n/a | The gateway is unavailable here. |

Connectors hosted by a provider (e.g. claude.ai Gmail) cannot be proxied on any provider; `strict-mcp-config` removes them
for Claude, other providers keep them.

## Restart behaviour

Session bindings are in memory. After a server restart a live run gets "not bound to a bot" from the gateway (fail
closed) until the kernel rebinds it.

## Binding secret

`gatewaySessions.bind` creates a random per-binding secret. Providers listed in `SECRET_STAMPING_PROVIDERS`
(`shared/bot-gateway-sessions.ts`, currently only `claude`) stamp it as `CLOUDCLI_BOT_GATEWAY_BINDING_SECRET` on the
gateway stdio entry; `bot-tool-gateway-mcp.ts` forwards it in `x-bot-gateway-binding-secret` and the route requires it
(timing-safe) for those bindings. Other providers cannot stamp it, so their session id alone identifies the caller:
they stay advisory.

## Registration

`registerBotGatewayMcp()` is a no-op when `CLOUDCLI_BOT_GATEWAY_REGISTER=0` or when the server runs with a non-default
`DATABASE_PATH` under a `tmp/` directory (isolated/test servers must not rewrite real provider configs).
`unregisterBotGatewayMcp()` removes the catalog entry; call it when the runtime stops or the flag turns off.
