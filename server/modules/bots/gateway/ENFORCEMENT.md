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
| codex | enforced with the built-in gate, else advisory | `openai-codex.js` with `options.botGatewayStrict` (set by `buildRuntimeOptions`; `applyRunOptions` adds `options.codexGatewayMcp`, the gateway launch spec from `getBotGatewayMcpLaunchSpec()`): the run gets a **throwaway `CODEX_HOME`** (`~/.cloudcli/codex-bot-homes/<session>-<rand>/`, `0700`, deleted when the app-server exits) holding no `config.toml`, a symlink to the operator's `auth.json`, and `rules/default.rules`. `--config mcp_servers={}` is NOT used: Codex merges config tables, so an empty override does not clear the user's servers (verified on 0.156.1; the Relay worker's `mcp_servers: {}` has the same flaw). Per-run `--config` overrides then add the gateway as the only MCP server. `<cwd>/.codex/config.toml` is neutralised by pinning `projects.<cwd and every ancestor and a linked worktree's main checkout>.trust_level = "untrusted"`: Codex otherwise auto-trusts the project on `thread/start` with a writable sandbox and loads its MCP servers/hooks/exec policies. Also off: `web_search`, `view_image`, `apps`, `plugins`, browser/computer use, `image_generation`, sub-agents (`multi_agent*`), `hooks`, `memories`, `goals`, `tool_suggest`, `shell_snapshot*` (the snapshot re-exports the server's whole env into every command and defeats `shell_environment_policy`). | `CLOUDCLI_SESSION_ID` and the API url are in the gateway entry's `env`; `CLOUDCLI_BOT_GATEWAY_BINDING_SECRET` and `CLOUDCLI_BOT_GATEWAY_MCP_TOKEN` are on the app-server env and forwarded **by name** (`env_vars`), so no secret ever appears on a command line. `default_tools_approval_mode = "approve"` (the gateway is the gate; Codex adds no prompt of its own) and `tool_timeout_sec = 2100` (gateway calls can block on a human). | Built-in tools: approval policy `untrusted` + `approvalsReviewer: user` on the thread and every turn, whatever the bot's permission mode (never `never`, never `danger-full-access`, never `auto_review`); `plan` keeps a read-only profile. Every `item/commandExecution/requestApproval`, `execCommandApproval`, `item/fileChange/requestApproval` (paths come from the preceding `item/started` fileChange item), `applyPatchApproval` and network-approval request is answered by awaiting `options.builtinToolGate`: shell -> `Bash {command, cwd}` (the `<shell> -lc '<script>'` wrapper is unwrapped when it parses cleanly), add -> `Write {file_path}`, update/delete -> `Edit {file_path}` (a move also gates the destination as `Write`), network -> `WebFetch {url}`, extra permissions a command asks for -> `Read`/`Write`/`WebFetch`. Allow answers `accept` only (never `acceptForSession`, never an execpolicy amendment); deny, a gate error, an unknown request, or a patch with no known target answer `decline`. `item/permissions/requestApproval` always grants nothing, MCP elicitations decline, dynamic tool calls fail. `rules/default.rules` forces a prompt for the programs older builds treat as "known safe" (0.156 already asks for all). A permission profile (`extends = ":workspace"` or `":read-only"`) denies reads of `~/.codex ~/.claude ~/.claude.json ~/.grok ~/.cursor ~/.config ~/.cloudcli ~/.ssh ~/.aws ~/.gnupg ~/.azure ~/.kube ~/.netrc ~/.git-credentials ~/Library/Keychains` and the real `CODEX_HOME` at the OS sandbox (more specific entries win: the run's cwd and the codex binary's install dir stay usable), so even an approved command cannot read them. Shell env excludes `CLOUDCLI_*`, `CODEX_HOME`, `*KEY*`/`*SECRET*`/`*TOKEN*`/`*PASSWORD*`/`*CREDENTIAL*`, `SSH_AUTH_SOCK`. Without `options.builtinToolGate` the run is MCP-isolated but approvals follow the normal human flow (unattended: bounded wait, then decline): advisory. |
| grok | enforced with the built-in gate, else advisory | `grok-cli.js` with `options.botGatewayStrict`: ACP `session/new` gets ONLY `cloudcli-tool-gateway` (catalog entry from `registerBotGatewayMcp`, API URL and token intact), and grok is started with a **per-run `GROK_HOME` built from scratch** (`modules/providers/list/grok/grok-strict-run.ts`), `--no-leader`, and env `GROK_CLAUDE_MCPS_ENABLED`/`GROK_CURSOR_MCPS_ENABLED`/`GROK_CODEX_MCPS_ENABLED`/`GROK_MANAGED_MCPS_ENABLED`/`GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED` = `false`. So grok does not read the user's `config.toml` MCP servers, `~/.claude.json`, `~/.cursor/mcp.json`, plugins, or grok.com connectors for this run. | `CLOUDCLI_SESSION_ID` and `CLOUDCLI_LEAD_SESSION_ID` are stamped on the gateway's ACP stdio env, together with `CLOUDCLI_BOT_GATEWAY_BINDING_SECRET` (gateway entry only, never grok's own env). | Built-in tools: the strict config sets `[ui] permission_mode = "default"` and `[permission] ask = ["*"]`, so grok asks for every tool call (reads and read-only shell commands included; `ask` outranks any `allow` rule from `.grok/config.toml`, `.claude/settings*.json`, remembered grants). Each `session/request_permission` is answered by awaiting `options.builtinToolGate(toolName, input)`: `run_terminal_command`->`Bash {command}`, `write`->`Write {file_path}`, `search_replace`->`Edit {file_path}`, `read_file`->`Read {file_path}` (grok's `target_file`), `list_dir`/`grep`->`Glob`/`Grep`, `web_fetch`->`WebFetch {url}`, `web_search`->`WebSearch`, `use_tool {tool_name}`->`mcp__<server>__<tool>` (only `cloudcli-tool-gateway__*` passes; any other MCP tool is denied by the gate). Allow selects `allow_once` only (never `allow_always`, never an "always-approve" row); deny, a gate error, or a missing allow option all reject. Never `--always-approve`; a live switch to bypass is refused. The run's home holds the login only (`auth.json`, `models_cache.json`): no user config, no `mcp_credentials.json`, no `trusted_folders.toml`, no remembered grants. It is `0700`, deleted when the turn ends (the child is not reused), and a rotated login plus the new transcripts are written back first (never `permission*.toml`). Without `options.builtinToolGate` the run is MCP-isolated but keeps its requested permission mode: advisory. |
| kimi | advisory | `session/new` is sent with `mcpServers: []`; Kimi reads its own config. | `CLOUDCLI_SESSION_ID` on spawn env. | The gateway is reachable only via Kimi's native config projection. |
| cursor | advisory | `cursor-agent` has no flag to disable `~/.cursor/mcp.json` / project `mcp.json`. | `CLOUDCLI_SESSION_ID` on spawn env. | Tool allow-lists are prompt advice only. |
| kilo, cline, qwencode | advisory | Share the OpenCode ACP runtime, but their native-config behaviour is unverified. | As opencode. | Promote to enforced once verified. |
| pi, omp | advisory | No MCP selection in their runners; native config only. | `CLOUDCLI_SESSION_ID` on spawn env. | |
| antigravity | enforced with the built-in gate (`getGatewayEnforcement('antigravity', { builtinToolGate: true })`), else advisory | Gateway-bound runs (`options.botGatewayStrict`) attach only `cloudcli-tool-gateway` through ACP `session/new`, whatever else `options.mcpServers` lists, and fail closed when the gateway is not bound to antigravity. The ACP child runs with a relocated `GEMINI_HOME` (see below), so the user's own Antigravity config, hooks, skills and workspace trust are not loaded. | Yes. `CLOUDCLI_SESSION_ID` and `CLOUDCLI_LEAD_SESSION_ID` are stamped on the gateway stdio entry itself (Antigravity's env inheritance for MCP children is not verified), plus `CLOUDCLI_SESSION_ID` on the ACP spawn env. The binding secret `CLOUDCLI_BOT_GATEWAY_BINDING_SECRET` is stamped on the gateway entry only (never on the ACP child env, which the agent's shell inherits). | See "Mechanism" and "Not covered". The run throws before spawning when `botGatewaySecret` or `appSessionId` is missing. |

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


## Provider details (Codex, Grok, Antigravity — 2026-10-01)

Full evidence, verified-vs-assumed notes and residual bypasses per provider. Adapters live in `gateway/providers/<provider>.ts`.

### Codex

#### Table row (replace the current `codex` row)

| Provider | Level | Strict selection | Session id reaches the stdio child | Notes |
|---|---|---|---|---|
| codex | enforced with the built-in gate, else advisory | `openai-codex.js` with `options.botGatewayStrict` (set by `buildRuntimeOptions`; `applyRunOptions` adds `options.codexGatewayMcp`, the gateway launch spec from `getBotGatewayMcpLaunchSpec()`): the run gets a **throwaway `CODEX_HOME`** (`~/.cloudcli/codex-bot-homes/<session>-<rand>/`, `0700`, deleted when the app-server exits) holding no `config.toml`, a symlink to the operator's `auth.json`, and `rules/default.rules`. `--config mcp_servers={}` is NOT used: Codex merges config tables, so an empty override does not clear the user's servers (verified on 0.156.1; the Relay worker's `mcp_servers: {}` has the same flaw). Per-run `--config` overrides then add the gateway as the only MCP server. `<cwd>/.codex/config.toml` is neutralised by pinning `projects.<cwd and every ancestor and a linked worktree's main checkout>.trust_level = "untrusted"`: Codex otherwise auto-trusts the project on `thread/start` with a writable sandbox and loads its MCP servers/hooks/exec policies. Also off: `web_search`, `view_image`, `apps`, `plugins`, browser/computer use, `image_generation`, sub-agents (`multi_agent*`), `hooks`, `memories`, `goals`, `tool_suggest`, `shell_snapshot*` (the snapshot re-exports the server's whole env into every command and defeats `shell_environment_policy`). | `CLOUDCLI_SESSION_ID` and the API url are in the gateway entry's `env`; `CLOUDCLI_BOT_GATEWAY_BINDING_SECRET` and `CLOUDCLI_BOT_GATEWAY_MCP_TOKEN` are on the app-server env and forwarded **by name** (`env_vars`), so no secret ever appears on a command line. `default_tools_approval_mode = "approve"` (the gateway is the gate; Codex adds no prompt of its own) and `tool_timeout_sec = 2100` (gateway calls can block on a human). | Built-in tools: approval policy `untrusted` + `approvalsReviewer: user` on the thread and every turn, whatever the bot's permission mode (never `never`, never `danger-full-access`, never `auto_review`); `plan` keeps a read-only profile. Every `item/commandExecution/requestApproval`, `execCommandApproval`, `item/fileChange/requestApproval` (paths come from the preceding `item/started` fileChange item), `applyPatchApproval` and network-approval request is answered by awaiting `options.builtinToolGate`: shell -> `Bash {command, cwd}` (the `<shell> -lc '<script>'` wrapper is unwrapped when it parses cleanly), add -> `Write {file_path}`, update/delete -> `Edit {file_path}` (a move also gates the destination as `Write`), network -> `WebFetch {url}`, extra permissions a command asks for -> `Read`/`Write`/`WebFetch`. Allow answers `accept` only (never `acceptForSession`, never an execpolicy amendment); deny, a gate error, an unknown request, or a patch with no known target answer `decline`. `item/permissions/requestApproval` always grants nothing, MCP elicitations decline, dynamic tool calls fail. `rules/default.rules` forces a prompt for the programs older builds treat as "known safe" (0.156 already asks for all). A permission profile (`extends = ":workspace"` or `":read-only"`) denies reads of `~/.codex ~/.claude ~/.claude.json ~/.grok ~/.cursor ~/.config ~/.cloudcli ~/.ssh ~/.aws ~/.gnupg ~/.azure ~/.kube ~/.netrc ~/.git-credentials ~/Library/Keychains` and the real `CODEX_HOME` at the OS sandbox (more specific entries win: the run's cwd and the codex binary's install dir stay usable), so even an approved command cannot read them. Shell env excludes `CLOUDCLI_*`, `CODEX_HOME`, `*KEY*`/`*SECRET*`/`*TOKEN*`/`*PASSWORD*`/`*CREDENTIAL*`, `SSH_AUTH_SOCK`. Without `options.builtinToolGate` the run is MCP-isolated but approvals follow the normal human flow (unattended: bounded wait, then decline): advisory. |

`ProviderGatewayAdapter` (`gateway/providers/codex.ts`): `applyRunOptions` sets `codexGatewayMcp`, `strictMcpSelection`, `botGatewayStrict`; `enforced(run)` is `run.builtinToolGate === true`. Implementation: `providers/list/codex/codex-gateway-strict.js` (config, env, managed home, approval mapping) and the strict branches in `openai-codex.js`. `codex-app-server.js` now sends any table with non-bare keys (an absolute path) as one inline table, because Codex splits a dotted `--config` key on every `.`, quoted or not.

#### Binding secret paragraph

Replace "currently only `claude`" with the current list (now including `codex`). `SECRET_STAMPING_PROVIDERS` is in `server/shared/bot-gateway-sessions.ts`; the route needed no change because it keys off `binding.secretRequired`. A strict codex run without `options.botGatewaySecret` fails before spawning.

#### Verified here (codex-cli 0.156.1, local mock model server, no external model)

`tmp/cloudcli/codex-probe/{mock-run,e2e}.mjs` drive the real `codex app-server` through the real `queryCodex` against a loopback Responses-API mock and a fake gateway MCP child:

- The model's tool list in a strict run is `exec_command, write_stdin, list_mcp_resources*, read_mcp_resource, request_user_input` plus the gateway namespace only (no `web_search`, `view_image`, sub-agents, goals, or any user/project MCP server). Without the overrides it also showed `view_image`, `multi_agent_v1`, `web_search`, goal tools.
- `config/read` and a real turn: a project `.codex/config.toml` MCP server starts (and its tools reach the model) after the auto-trust; with the `untrusted` pins it does not, and Codex no longer writes a `trust_level` into the home.
- `--config mcp_servers={}` leaves the user's servers in place (`config/read` before/after).
- The gateway child receives `CLOUDCLI_SESSION_ID`, the API url, the binding secret and the MCP token; the secret and token are absent from argv.
- Every `exec_command` produced `item/commandExecution/requestApproval` under `untrusted` (cat, ls, echo, python3 alike); a `decline` shows as `rejected by user` to the model; `apply_patch` via the shell produced `item/fileChange/requestApproval` with the target path only on the earlier `item/started` item (gate saw `Write <abs path>`); an MCP gateway call ran with no extra prompt.
- OS deny: `ls ~/.codex`, `ls ~/.ssh`, `cat ~/.cloudcli/auth.db` fail with "Operation not permitted" even when the gate approves; writes outside cwd fail; cwd stays writable; the codex fs-sandbox helper needs the install dir read-allowed (otherwise `thread/start` fails).
- A `rules/default.rules` in a custom `CODEX_HOME` is loaded (a `forbidden` rule suppressed the command); `codex execpolicy check` accepts the generated rules.
- `shell_environment_policy` is bypassed by `shell_snapshot` when a login is present (all server env, including secrets, showed up in the shell); disabling the snapshot restores it.
- Symlinked `auth.json` in a custom `CODEX_HOME` is accepted (`codex login status`).

#### Assumed / not verified

1. Token refresh behaviour with the symlinked `auth.json` (no network refresh was triggered): write-through if Codex truncates in place; if it replaces the link, `cleanup()` considers copying the regular file back, but only through `guardedLoginWriteBack` (see "Login write-back" below): the real login is fingerprinted at run start and is replaced only if it is still exactly that and the run's file is newer. Two concurrent strict runs plus the operator's own Codex share one refresh token; whether OpenAI rotates refresh tokens with reuse detection is not verified.
2. `apply_patch` as a *model tool* (freeform) was not offered by the mock model's catalog; the patch path was exercised through the shell interception and a fake app-server (v2 and legacy requests).
3. Linux sandbox (`bwrap`) honouring the same `filesystem` deny entries; only macOS Seatbelt was exercised.
4. Network is off in the `:workspace` profile (a loopback `curl` exited 7), but that was not separated from "connection refused" by the probe.
5. The bot's own home is denied to shells when the run's cwd is a project (it is re-allowed only when it is the cwd); bots reach their skills/spaces through the gateway's first-party tools.

#### Residual bypasses

- The gate's decision is text/path based, as for Claude. A command the gate approves can still read indirectly any path the sandbox allows (everything outside the denied credential stores), and anything the operator approves runs with the sandbox's reach.
- Credential stores outside the deny list are readable by an approved command (the list is `strictDenyReadPaths`; since 2026-10-01 it includes `~/.gemini`, `~/.docker`, `~/.zsh_history`, `~/.bash_history` and `~/Library/Application Support`, with the codex install dir re-allowed). Anything the operator approves at the Action Gate still runs with the sandbox's reach.
- Model-visible skills and `AGENTS.md` from the project still load (instructions only; their scripts run through the gated shell).
- Codex's own startup traffic (rate limits, model catalog, analytics) uses the login and is not a bot action; it is not gated.
- A run that crashes the server mid-flight leaves its managed home (no secrets, a link to `auth.json`) until the next strict run starts, which sweeps homes older than 24 h.
- Sessions of a strict run live in the throwaway home and vanish with it; Bot Studio run history comes from CloudCLI's own run events.

### Grok

#### Table row (replace the current `grok` row)

| Provider | Level | Strict selection | Session id reaches the stdio child | Notes |
|---|---|---|---|---|
| grok | enforced with the built-in gate, else advisory | `grok-cli.js` with `options.botGatewayStrict`: ACP `session/new` gets ONLY `cloudcli-tool-gateway` (catalog entry from `registerBotGatewayMcp`, API URL and token intact), and grok is started with a **per-run `GROK_HOME` built from scratch** (`modules/providers/list/grok/grok-strict-run.ts`), `--no-leader`, and env `GROK_CLAUDE_MCPS_ENABLED`/`GROK_CURSOR_MCPS_ENABLED`/`GROK_CODEX_MCPS_ENABLED`/`GROK_MANAGED_MCPS_ENABLED`/`GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED` = `false`. So grok does not read the user's `config.toml` MCP servers, `~/.claude.json`, `~/.cursor/mcp.json`, plugins, or grok.com connectors for this run. | `CLOUDCLI_SESSION_ID` and `CLOUDCLI_LEAD_SESSION_ID` are stamped on the gateway's ACP stdio env, together with `CLOUDCLI_BOT_GATEWAY_BINDING_SECRET` (gateway entry only, never grok's own env). | Built-in tools: the strict config sets `[ui] permission_mode = "default"` and `[permission] ask = ["*"]`, so grok asks for every tool call (reads and read-only shell commands included; `ask` outranks any `allow` rule from `.grok/config.toml`, `.claude/settings*.json`, remembered grants). Each `session/request_permission` is answered by awaiting `options.builtinToolGate(toolName, input)`: `run_terminal_command`->`Bash {command}`, `write`->`Write {file_path}`, `search_replace`->`Edit {file_path}`, `read_file`->`Read {file_path}` (grok's `target_file`), `list_dir`/`grep`->`Glob`/`Grep`, `web_fetch`->`WebFetch {url}`, `web_search`->`WebSearch`, `use_tool {tool_name}`->`mcp__<server>__<tool>` (only `cloudcli-tool-gateway__*` passes; any other MCP tool is denied by the gate). Allow selects `allow_once` only (never `allow_always`, never an "always-approve" row); deny, a gate error, or a missing allow option all reject. Never `--always-approve`; a live switch to bypass is refused. The run's home holds the login only (`auth.json`, `models_cache.json`): no user config, no `mcp_credentials.json`, no `trusted_folders.toml`, no remembered grants. It is `0700`, deleted when the turn ends (the child is not reused), and a rotated login plus the new transcripts are written back first (never `permission*.toml`). Without `options.builtinToolGate` the run is MCP-isolated but keeps its requested permission mode: advisory. |

`ProviderGatewayAdapter` (`gateway/providers/grok.ts`): `applyRunOptions` forces `permissionMode = 'default'`; `enforced(run)` is `run.builtinToolGate === true`.

#### Binding secret paragraph

Replace "currently only `claude`" with "currently `claude` and `grok`" (plus whatever Antigravity adds). `SECRET_STAMPING_PROVIDERS` is in `server/shared/bot-gateway-sessions.ts`. grok-cli.js stamps the secret on the gateway's ACP env; the route (`gateway.routes.ts`) needed no change because it keys off `binding.secretRequired`.

#### Verified here (grok 1.0.46, no model or network call)

- `grok inspect --json` with a home generated by `createStrictGrokHome`: no `configWarnings`, user layer loaded, the `ask` rule counted (permission rules 11 -> 12), `externalCompat` cells `claude.mcps`/`cursor.mcps` disabled (`source: env`), `projectTrusted: false`. With the same `GROK_HOME` but no `[compat.*] mcps = false`, the servers in `~/.claude.json` show as active; with it (config or env) they show `disabled`.
- Real tool names and input keys from `~/.grok/sessions/*/chat_history.jsonl` and `events.jsonl`: `run_terminal_command {command}`, `read_file {target_file}`, `list_dir {target_directory}`, `search_replace`/`write {file_path}`, `web_fetch {url}`, `grep`, `todo_write`, `spawn_subagent`, and MCP tools reached as `use_tool {tool_name: "server__tool", tool_input}`. The mapping is built on those.
- `grok agent --no-leader stdio` is accepted.
- `spawnGrok` end to end against a fake ACP `grok` on PATH (`bots-provider-grok.test.ts`): `session/new` mcpServers, stamped env, the home contents and mode, deletion, write-back, env stripping, gate allow/deny/throw mapping, flag off unchanged.

#### Assumed (read from grok's embedded user guide, not exercised against a live model)

1. `[permission] ask = ["*"]` makes grok send `session/request_permission` for read-only tools and read-only shell commands too, and wins over `allow` rules from every source. (Guide: "any matching ask prompts, otherwise any matching allow approves"; "a bare `*` rule matches every tool".) The existing code already depended on the request flow for non-read tools.
2. Project-scoped servers (`<cwd>/.grok/config.toml`, `.mcp.json`, `.cursor/mcp.json`) are not started for an untrusted folder, and the strict home trusts none. `grok inspect` still lists them, so this was not observable offline. grok-cli.js logs a warning when such files exist.
3. `GROK_MANAGED_MCPS_ENABLED=false` / `GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED=false` stop the grok.com connector catalog. `inspect` does not show connectors. Backstop if this is wrong: connector tools are `use_tool` calls, which `ask = ["*"]` sends to the gate, and the gate denies every non-gateway MCP tool.
4. The gateway's tool arrives as `use_tool {tool_name: "cloudcli-tool-gateway__<tool>"}` (observed for other servers). If a request is not recognised it reaches the gate under grok's own name, which the gate classifies as unknown/risky and escalates to a human: noisy, not open.
5. Subagent (`spawn_subagent`) tool asks reach the same ACP client. The spawn itself is unknown to the gate and escalates.
6. Concurrent strict runs each start from the same refresh token. A run that starts while a sibling is active first flushes the sibling's already-refreshed login to the real home and copies that, so runs started one after another see the newest login; runs that start at the same instant still share a token. Whether xAI rotates refresh tokens with reuse detection (which would log a loser out) is NOT verified. At write-back the run's copy is applied only if the real login is unchanged since the run started (see "Login write-back" below); otherwise it is discarded and logged.

#### Residual bypasses

- grok's own hooks, skills, rules and agents from `~/.claude` / `~/.cursor` are still scanned (only MCP imports are off). They are operator-authored and cannot add a tool path, but a hook runs commands outside the gate.
- Once the gate allows a command (for example `node script.js` inside the workspace) that process is not OS-sandboxed; the same holds for Claude.
- The server's environment is inherited by grok and the shell tools it runs. The gate's denylist blocks `env`/`printenv`/`/proc/*/environ`, not every other way to read a variable.
- Project-scoped MCP relies on assumption 2.

### Antigravity

Merge the table row, the binding-secret sentence and the notes below into `gateway/ENFORCEMENT.md`.
Code: `providers/list/antigravity/antigravity-gateway.ts` (mechanism), `gateway/providers/antigravity.ts` (adapter),
`server/opencode-cli.js` (`spawnAntigravity` wiring, antigravity-only branches).

#### Table row

| Provider | Level | Strict selection | Session id reaches the stdio child | Notes |
|---|---|---|---|---|
| antigravity | enforced with the built-in gate (`getGatewayEnforcement('antigravity', { builtinToolGate: true })`), else advisory | Gateway-bound runs (`options.botGatewayStrict`) attach only `cloudcli-tool-gateway` through ACP `session/new`, whatever else `options.mcpServers` lists, and fail closed when the gateway is not bound to antigravity. The ACP child runs with a relocated `GEMINI_HOME` (see below), so the user's own Antigravity config, hooks, skills and workspace trust are not loaded. | Yes. `CLOUDCLI_SESSION_ID` and `CLOUDCLI_LEAD_SESSION_ID` are stamped on the gateway stdio entry itself (Antigravity's env inheritance for MCP children is not verified), plus `CLOUDCLI_SESSION_ID` on the ACP spawn env. The binding secret `CLOUDCLI_BOT_GATEWAY_BINDING_SECRET` is stamped on the gateway entry only (never on the ACP child env, which the agent's shell inherits). | See "Mechanism" and "Not covered". The run throws before spawning when `botGatewaySecret` or `appSessionId` is missing. |

Binding secret: `SECRET_STAMPING_PROVIDERS` is now `['claude', 'antigravity']`; the route requires the secret for antigravity bindings.

Registration: `GATEWAY_PROVIDERS` now includes `antigravity`. Antigravity has no on-disk MCP config, so the binding is only recorded in
`catalog.json` (`syncBindings` skips providers with zero scopes) and the entry is attached per run via `session/new`. Ordinary
(non-gateway) Antigravity chats do not receive the gateway even though it is bound: `resolveOpenCodeAcpMcpServers` skips it unless it is
requested explicitly. opencode keeps attaching it as before.

#### Mechanism

Evidence base: the Python source bundled in `~/.cloudcli/antigravity/1.1.1/agy_acp_server.par` (read with `strings`; the binary was never
started, because starting it signs in to Google). Everything below marked "source" comes from there.

1. MCP (source: `mcp_servers.py`, `server.py::_create_agent_config`). The server merges the client's `session/new` `mcpServers` with
   `<GEMINI_HOME>/config/mcp_config.json` (client wins on a name clash). `GEMINI_HOME` relocates the whole tree ("lets an embedding IDE isolate
   this server's configuration and state from the user's other Antigravity surfaces"). CloudCLI already pins `GEMINI_HOME` to a private
   profile, so `~/.gemini` is never read. A gateway-bound run goes one step further: `prepareAntigravityStrictHome()` creates
   `<profile>/runs/<hash(appSessionId)>/` with an empty real `config/` (no global MCP/hooks/skills), its own `settings.json`, no
   `trusted_workspaces.json`, and symlinks for everything else in `antigravity-acp/` (token, conversations, brain). The server follows the
   symlinks; its own `view_file`/`client_view_file` resolve them first and refuse the target as outside `cwd + GEMINI_HOME + skills dirs`, so
   the agent's read tools cannot read the OAuth token or other sessions' transcripts. `AGY_ACP_DISABLE_WORKSPACE_TRUST=0` is forced.
   Run homes older than a day are pruned on the next gateway-bound spawn.
2. Built-in tools (source: `server.py::_permission_handler`, `policy.safe_defaults`). Every tool except the read-only builtins (list_directory,
   search_directory, find_file, view_file, finish) and `ask_question` is `ask_user("*")`, including shell (`run_command`), file create/edit
   (`client_create_file`, `client_edit_file`, ...), `read_url_content`, `search_web`, `generate_image`, `start_subagent` and every MCP tool.
   The ask is an ACP `session/request_permission` request. The handler skips it only for session mode `yolo` (everything), `auto_edit`
   (edit tools) and the per-session "Allow Always" cache. A gateway-bound run therefore:
   - forces mode `default` (`antigravityGatewayPolicy()`, also set by the adapter's `applyRunOptions`) and refuses live switches
     (`updateAcpPermissionMode` returns false);
   - answers each request with `options.builtinToolGate` through `createAntigravityGatewayGuard`: `kind: execute` -> `Bash {command}`
     (from `rawInput.CommandLine`, else the title, which Antigravity sets to the command line), `kind: edit` -> `Write`/`Edit {file_path}`
     (path from `locations` or the args), `kind: fetch` -> `WebFetch {url}`, `search_web` -> `WebSearch {query}`, `_meta.mcp` ->
     `mcp__<server>__<tool>` (the gate passes only the gateway's, denies every other MCP server), anything else under its own tool name. A call
     whose target cannot be determined is denied. The answer is `allow_once` or `reject_once`; "Allow Always" is never selected;
   - with no `builtinToolGate` installed, denies every built-in action (the gateway's own MCP tools stay usable);
   - cancels interaction prompts (`ask_question`, and the workspace-trust question that offers `trust`/`deny`): they have no tool `kind` and
     no `allow`/`deny` option ids. Auto-approving the trust prompt would have trusted workspace `hooks.json`;
   - routes ACP `fs/read_text_file` (always, `client_view_file` is never asked) and `fs/write_text_file` through the gate. A write whose
     `client_*_file` permission step was just approved passes once without a second decision; any other write is gated on its own.
3. Because the gate runs inside the run's own `onAcpMessage`, no human permission prompt is raised for gateway-bound runs; the Action Gate
   (`server: 'builtin'`) asks the operator when the classifier escalates, exactly as on Claude.

#### Verified vs assumed

Verified by tests with fakes (no real binary, no network): gateway-only `mcpServers` with the stamped env, the `GEMINI_HOME` stamp, mode
forced to `default`, permission request -> gate mapping and allow_once/reject/cancel answers, fs read/write gating, fail-closed
conditions, opencode and flag-off behaviour unchanged, secret required by the route.

Read from the bundled ACP server source, not exercised live: the permission/MCP/trust/home behaviour above, the shape of
`session/request_permission` params (`toolCall.kind`, `locations`, `rawInput`, `_meta.mcp`), and that the symlinked profile entries work
for the Go harness. Assumed: that Antigravity does not spell the server name differently from the one we configured (the gateway name is
matched with `-` or `_`), and that the `_meta` key reaches us as `_meta`.

#### Not covered (why `enforced` is still labelled with these caveats)

- Read-only builtins (`list_directory`, `search_directory`, `find_file`, `view_file`) never ask and so cannot reach the gate. Antigravity
  confines them to the workspace, the run home and its skills directories; with the symlinked run home that no longer includes the token.
  They read workspace files without a gate decision (the Claude gate would also approve those for a worker seat).
- An "Allow Always" saved in the sidecar metadata of a session that a bot resumes (made by an earlier, non-bot chat) is honoured by the
  server before it asks. Bot runs normally start new sessions.
- `.agents/` workspace customization (plugins carrying an `mcp_config.json`, skills): the plugin MCP servers would load, but every call to
  them is a permission request and is denied by the gate; the processes may still be started. Workspace `hooks.json` is not loaded
  (trust is never granted and the run home has no trust file).
- Shell commands are judged by the same classifier and denylist as Claude (cannot see through arbitrary scripts).
- If the operator's Antigravity auth were an enterprise (oauth-business) session, admin controls could auto-proceed terminal commands
  without asking. `prepareAntigravityProfile` pins `auth.type = oauth-personal` on every launch, so this does not apply today.


## Credential-exposure hardening (2026-10-01)

Security review of gateway-bound runs found that shell reads of the per-run login copies were auto-approved. Everything below
applies only to gateway-bound bot runs: it lives in the built-in gate (`gate/builtin-tool-gate.ts`, `gate/strict-guard.ts`) and the
`botGatewayStrict` branches of the Codex / Grok / Antigravity runners. The shared permission classifier is unchanged, so Relay
workers and every interactive (non-bot) session of any provider behave exactly as before (asserted in
`bots-builtin-gate-hardening.test.ts`, last test).

### Built-in gate (all providers that use `options.builtinToolGate`)

Order is now: MCP pass-through, hard denylist (old list **plus** the strict name/variable rules), classifier, then **escalation**
(strict escalations, tainted-run rule, classifier escalations) through the Action Gate.

Hard deny (never asked, recorded as `denylist`):

- Any path segment or shell word naming `.cloudcli .grok .codex .gemini .claude .claude.json .cursor .docker .ssh .aws .azure
  .kube .gnupg .netrc .git-credentials .zsh_history .bash_history`, `Library/Keychains`, `Library/Application Support`, the
  credential files `auth.json acp_token.json acp_business_token.json oauth_creds.json credentials.json mcp_credentials.json`,
  `*.pem`, `id_rsa*`, `id_ed25519*`, and the copies of logins under `~/.cloudcli`: `grok-strict-runs`, `codex-bot-homes`,
  `grok-runtime`, `antigravity-acp`. Case-insensitive (APFS is). Checked on the decoded word (quotes, backslashes and `""`
  splicing removed), on the resolved path (symlinks followed, `..` after a symlink resolved the way the shell does), on the raw
  command text (so names inside `python -c`/`node -e`/`sh -c` payloads and `file://` URLs count), and on glob patterns.
  Names are judged relative to the workspace root when the path is inside it. Exempt: anything that resolves inside the bot's own
  home (`~/.cloudcli/bots/<id>/home`), and nothing else (siblings and parents of it are protected).
- Any reference to `HOME`, `GROK_HOME`, `CODEX_HOME`, `GEMINI_HOME`, `CLOUDCLI_*`, `XDG_*` (`$X`, `${X}`, `${!X}`, inside
  `$(...)`, backticks, double or single quotes, unquoted heredoc bodies).
- `ps eww` / `ps auxe` / `ps -E` (another process's environment).

Escalated (a human decides; auto-denied when nobody answers in time):

- Shell paths outside workspace, bot home and OS temp: absolute and `~` paths, `~user`, `..` that leaves, `cd` elsewhere
  (`cd`, `cd -`, `pushd`, `popd`, cd to a missing directory followed by `..`), globs whose static prefix is outside, an input
  `cwd` outside. Absolute system executables (`/bin/ls`) and `/dev/null|stdin|stdout|stderr` are not counted.
- Any other `$VAR`/`${VAR}`, command substitution (except `$(pwd)`, `$(date ...)`, `$(cat <<'EOF' ... EOF)` data), process
  substitution, ANSI-C quoting, indirect expansion, an unterminated quote, a `<<` the classifier would misread (the classifier
  drops "heredoc bodies" with a line scan, so `echo "<<EOF"` + newline + a real command would hide that command from it).
- Read/view_file/Glob/Grep (and other path tools, `file://` fetches) outside workspace, bot home and OS temp.
- Tainted runs: on the auto-approve path every shell command other than a pure read (classifier category `read`, no
  redirects) escalates. `ctx.tainted()` is read per call.

Known costs: a prose mention of a protected name inside a command (a commit message saying `.claude`, `grep auth.json`) is
denied as written (bodies of quoted heredocs are data and are exempt); a project that really has `.claude/` or `.codex/` inside the
workspace cannot be read or edited by a bot through the built-in tools.

Residual (best-effort token-level model, not a shell): the Claude Bash tool keeps its working directory between calls, so after an
operator-approved `cd` somewhere else, later relative commands are still judged against the workspace; variable-indirect paths
(`eval`, scripts the bot wrote and then runs) are only as safe as the classifier's view of the script, which is why running
project code still goes through the classifier and, for bots, the escalation of anything it cannot call a read; a command an
operator approves runs with the process's full reach.

### Codex OS sandbox

`strictDenyReadPaths` also denies `~/.gemini`, `~/.docker`, `~/.zsh_history`, `~/.bash_history` and `~/Library/Application
Support`. A codex binary installed under a denied directory stays readable: `strictAllowReadPaths` adds its install root as the
more specific `read` entry (tested with a launcher under `Library/Application Support`).

### Login write-back (Codex and Grok)

Both use `providers/shared/login/login-writeback.ts`: the real `auth.json` is fingerprinted (mtime, size, sha256) when the run
starts; at the end the run's file replaces it only if the real file still matches that fingerprint AND the run's file is newer
AND it still parses as JSON (if the original did); the new content goes to a temp file (0600) in the real file's directory, the
fingerprint is re-checked immediately before the atomic `rename`, and any mismatch discards the run's copy with a log line. No
login is ever created from a run copy and a logout is never undone.

- Codex keeps the symlink design on purpose: an in-place refresh then reaches the real file directly and can never be lost to a
  discard. The guarded path only handles Codex replacing the link with a regular file.
- Grok copies the login, so it has the guard at both ends: `createStrictGrokHome` first flushes (same guards) the refreshed login of
  any strict run still active in the process, then copies the latest real `auth.json` fresh at every start; all of that and every
  write-back run inside `withStrictGrokAuthLock`, a process-wide async mutex (`grok-cli.js` creates and disposes homes through
  it). The critical sections are synchronous, so within one process they were already atomic; the mutex enforces that as an
  invariant. Across processes (a second server, the operator's own `grok login`) only the fingerprint re-check protects the real
  file.
- Not verified, on either provider: whether the provider rotates refresh tokens with reuse detection. If it does, two runs that
  refresh from the same token at the same moment can still log each other (or the operator) out; the guards make sure the real
  file is never clobbered by a stale copy, they cannot prevent the provider revoking a session.

### Antigravity

Verified from the bundled ACP server source (`FileCredentialStore.write`): the token is written to a temp file in the same
directory and `os.replace`d onto `acp_token.json`. In a run home that path is a symlink, and a rename over a symlink replaces the
symlink itself: the real token is never written, truncated or unlinked by a run, and a refresh made inside the run lands as a
regular file in the run home. Nothing copies it back (there is no write-back code for Antigravity); the file goes away with the run
home when it is pruned, and the prune logs `acp_token.json was replaced by a regular file ... discarded`. `clear()` unlinks only the
link. Test: `antigravity-gateway.test.ts` ("never writes the real token back"). Consequence to be aware of: an in-run refresh is
lost, which is harmless as long as Google's refresh token does not rotate on refresh (not verified).

On macOS the ACP server prefers the OS keychain (service `gemini`, account `antigravity-acp`) over the token file unless
`AGY_ACP_FORCE_FILE_STORAGE` is set. The relocated `GEMINI_HOME` does not isolate the keychain; the gate's `security`/`keychain`
rules and the classifier's `security` rule are what stop a bot shell from reading it. The shell-read attack on the file
(`cat "$GEMINI_HOME/antigravity-acp/acp_token.json"`) is hard-denied by the variable rule, the `antigravity-acp` and
`acp_token.json` name rules.


## Autonomy levels

The old provider "permission mode" is no longer something an operator picks per bot for gated runs: on a gateway-bound run
it is overridden anyway (claude-sdk forces default mode plus `canUseTool`; the grok, codex and antigravity adapters likewise).
Each bot instead has one provider-agnostic **autonomy** level, stored as `runtime_json.autonomy` (`careful` by default) and
edited with `PATCH /api/bots/:botId/runtime { autonomy }` (`null` resets to careful). `resolveBotAutonomy` /
`readBotAutonomy` (bots-runtime-config.ts) are the only readers; everything below goes through them.

| Level | Gateway | Floor risks (send / publish / delete / purchase / prod_change) | `credential` | Built-in tool escalations | Hard denies |
|---|---|---|---|---|---|
| `careful` (default) | on | ask a human | ask | ask a human | denied |
| `trusted` | on | allowed, audited as `decidedBy: 'autonomy:trusted'`, unless the run is tainted | always ask | allowed unless the run is tainted | denied |
| `unrestricted` | **off** | not gated | not gated | not gated | **not enforced** |

- **careful** is exactly the pre-autonomy behaviour.
- **trusted** acts like an implicit bot-scoped allow for the floor risks, in `actionGate.evaluate` (action-gate.service.ts), step
  3-4. It replaces only the bare floor `ask`. Everything around it still applies, in this order: dry run (deny), budget (deny),
  explicit and section-policy `deny` / `ask` rules (they win, so a deny rule still blocks a floor risk), then the **taint**
  rule (a tainted run's floor call goes to a human even though trusted would allow it). `credential` risk, `unknown` risk and
  anything an explicit rule does not allow are unchanged. Because the built-in tool gate routes its escalations through the same
  Action Gate (risk is computed from every reference in the call, not the first escalation reason: a shell command that names a
  sensitive file anywhere, or a network command that names any file outside the workspace and bot home, is `credential`, which
  trusted never auto-allows; other network commands are `send`; the rest `prod_change`. See gate/command-risk.ts), trusted also lets out-of-workspace paths, env refs, unresolved paths and risky shell commands run when the run
  is not tainted, with a `bot_gate_decisions` row and an `executed` outcome. The hard denylist (protected credential names and
  dirs, `~/.claude.json`, database files, env dumps, keychain, the CloudCLI API on localhost, MCP launches) is checked before
  any of this and stays denied at every level, tainted or not. Trusted removes human review of destructive and outbound
  actions; it is not a sandbox.
- **unrestricted**: `shouldUseToolGateway(section)` returns false, so the run is built like a pre-v2 run: no
  `cloudcli-tool-gateway`, no built-in tool gate, the section's own `tools` as MCP servers and the provider's own permission
  mode (`section.permission_mode`, default `bypassPermissions`, true bypass). Nothing is checked or held, none of the hard
  denies apply, and `getGatewayEnforcement` is replaced by level **`off`** in the enforcement routes
  (`GET /api/bots/:botId/enforcement`, `GET /api/bots/enforcement/preview?provider=&autonomy=`). The one remaining
  per-tool control is the section `tool_policy`, which the Claude options builder still turns into allow/deny lists. A bot that
  reaches the Action Gate anyway (a direct call) is treated as careful.
- **Fails closed**: `shouldUseToolGateway` returns true (gateway on) when the runtime config cannot be read, and a missing bot
  or unreadable config reads as `careful`. Only an explicit `unrestricted` switches the gateway off.
- **Legacy `gateway: false`** is still accepted and migrates on read to `autonomy: 'unrestricted'`; an explicit `autonomy`
  wins over it, and patching `autonomy` drops the stale flag. `gateway: true` on a migrated bot returns it to careful.
- **Audit**: a change is recorded as a section version (the version snapshot carries `autonomy` when it is not `careful`, so
  existing snapshots still match) and as a system message in the bot's thread ("Autonomy changed to Trusted by you").
- **Browser**: while the operator is signed in to a bot's browser profile ("Sign in as this bot"), kernel wakes for that bot
  defer with `reason: 'browser_in_use'` (events stay queued, retried every `browserRetryMs`, and immediately on finish).
