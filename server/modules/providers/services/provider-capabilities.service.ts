import type { LLMProvider } from '@/shared/types.js';

/**
 * Static, backend-owned description of what one provider integration supports.
 *
 * The frontend renders its composer UI (permission mode picker, image upload,
 * abort button, ...) purely from this shape, which is what keeps the frontend
 * free of per-provider conditionals. New provider features should be exposed
 * here instead of branching on the provider id in React components.
 */
type ProviderCapabilities = {
  provider: LLMProvider;
  /** Permission modes the provider runtime understands, in cycle order. */
  permissionModes: string[];
  defaultPermissionMode: string;
  /** Whether image attachments (paste/upload) can be included in a chat.send.
   * Delivery differs by runtime: Claude uses base64 vision blocks; most others
   * pass local asset paths via `<images_input>` / local_image items. */
  supportsImages: boolean;
  /** Whether non-image file attachments (PDF, spreadsheets, text, …) can be
   * included in a chat.send. Delivered to the runtime by path reference, which
   * every agent can read with its file tools — so this is true everywhere even
   * for providers without image vision. */
  supportsFiles: boolean;
  /** Whether an in-flight run can be cancelled via chat.abort. */
  supportsAbort: boolean;
  /** Whether interactive tool permission prompts can reach the UI. */
  supportsPermissionRequests: boolean;
  /** Whether the token-usage endpoint has data for this provider. */
  supportsTokenUsage: boolean;
  /** Whether the provider runtime can accept model-level reasoning effort. */
  supportsEffort: boolean;
};

/**
 * The capability matrix mirrors what each runtime actually implements today:
 * - permission modes match the option sets accepted by each CLI/SDK.
 * - Claude and Codex app-server integrations surface interactive permission
 *   requests; the remaining headless integrations do not.
 * - Cursor has no token usage endpoint support (its store.db has no usage rows).
 */
const PROVIDER_CAPABILITIES: Record<LLMProvider, ProviderCapabilities> = {
  claude: {
    provider: 'claude',
    // Claude CLI --permission-mode: acceptEdits | auto | bypassPermissions |
    // manual | dontAsk | plan. CloudCLI "default" omits the flag (SDK default /
    // prompt-first, equivalent to daily interactive use). dontAsk is omitted
    // because deny-by-default is a poor fit for interactive chat.
    permissionModes: ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan'],
    defaultPermissionMode: 'default',
    supportsImages: true,
    supportsFiles: true,
    supportsAbort: true,
    supportsPermissionRequests: true,
    supportsTokenUsage: true,
    supportsEffort: true,
  },
  cursor: {
    provider: 'cursor',
    // cursor-agent headless only exposes force-approve via `-f`. There is no
    // acceptEdits/plan flag on the path CloudCLI uses (see cursor-cli.js).
    permissionModes: ['default', 'bypassPermissions'],
    defaultPermissionMode: 'default',
    supportsImages: true,
    supportsFiles: true,
    supportsAbort: true,
    supportsPermissionRequests: false,
    supportsTokenUsage: false,
    supportsEffort: false,
  },
  codex: {
    provider: 'codex',
    // Codex Auto uses on-request plus its model-backed auto_review reviewer;
    // requests that the reviewer cannot safely classify still reach Chatbar.
    permissionModes: ['default', 'auto', 'bypassPermissions'],
    defaultPermissionMode: 'default',
    supportsImages: true,
    supportsFiles: true,
    supportsAbort: true,
    supportsPermissionRequests: true,
    supportsTokenUsage: true,
    supportsEffort: true,
  },
  opencode: {
    provider: 'opencode',
    // Rewritten onto OpenCode's Agent Client Protocol (`opencode acp`), not the
    // one-shot `opencode run`: modes map to the session's `mode` config option
    // (build|plan) plus an OPENCODE_PERMISSION policy that forces the permission
    // types we want *relayed* to "ask". See resolveOpenCodePermissionPolicy in
    // opencode-cli.js. `auto` leaves the user's own config in charge and
    // approves locally, so it is still not a true deny-rule-skipping bypass.
    permissionModes: ['default', 'acceptEdits', 'auto', 'plan'],
    defaultPermissionMode: 'default',
    supportsImages: true,
    supportsFiles: true,
    supportsAbort: true,
    // ACP delivers `session/request_permission` as a real request the client
    // must answer — under `opencode run` there was no ask to answer, only a
    // silent auto-reject. (Verified live 2026-08-11, scripts/probe-opencode-acp.mjs.)
    supportsPermissionRequests: true,
    supportsTokenUsage: true,
    supportsEffort: true,
  },
  grok: {
    provider: 'grok',
    // grok-cli.js runs Grok over ACP (`grok agent stdio`). Modes map to a
    // CloudCLI-managed GROK_HOME config (`[ui] permission_mode`) plus optional
    // `--always-approve`. Grok also has dontAsk (not exposed — deny-by-default
    // is a poor fit for interactive chat). Auto is a classifier, not yolo.
    // CLI: default | acceptEdits | auto | bypassPermissions | plan.
    permissionModes: ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'plan'],
    defaultPermissionMode: 'default',
    // Grok Build accepts images from the clipboard / attachments. Delivered as
    // path references via `<images_input>` in grok-cli.js (same pattern as
    // Cursor/OpenCode), not base64 content blocks.
    supportsImages: true,
    supportsFiles: true,
    supportsAbort: true,
    supportsPermissionRequests: true,
    // Real per-turn usage lives in the session's updates.jsonl
    // (turn_completed events) and is summed by the /token-usage route.
    supportsTokenUsage: true,
    supportsEffort: true,
  },
  kimi: {
    provider: 'kimi',
    // Rewritten onto Kimi's real Agent Client Protocol (`kimi acp`), not the
    // old one-shot `-p` mode. Verified live (2026-07-18): `session/new`
    // exposes a real "mode" configOption (default/plan/auto/yolo) settable
    // via `session/set_config_option`, and `default`/`plan` genuinely pause
    // and send a `session/request_permission` request that must be answered
    // before the tool proceeds — confirmed by killing an unanswered request
    // and seeing the target file survive, then answering it and seeing the
    // tool actually run. There is no direct equivalent of cloudcli's
    // "acceptEdits" in Kimi's mode vocabulary, so only these 4 (not 5) are
    // exposed, each a genuine 1:1 mapping (bypassPermissions -> Kimi "yolo").
    permissionModes: ['default', 'plan', 'auto', 'bypassPermissions'],
    defaultPermissionMode: 'bypassPermissions',
    // Path-referenced attachments via appendImagesInputTag in kimi-cli.js.
    supportsImages: true,
    supportsFiles: true,
    supportsAbort: true,
    // The permission bridge reuses the same pendingToolApprovals mechanism
    // as Claude's SDK integration (waitForToolApproval/resolveToolApproval,
    // exported from claude-sdk.js) - see kimi-cli.js.
    supportsPermissionRequests: true,
    // No structured usage event exists on the live ACP wire, but real
    // per-turn usage IS persisted to disk as `usage.record` entries in the
    // session's agents/main/wire.jsonl - summed by the /token-usage route.
    supportsTokenUsage: true,
    // kimi-code 0.30.0 exposes a real "thinking" configOption over ACP whose
    // values mirror the model's support_efforts from config.toml (e.g.
    // low/high/max for k3); kimi-cli.js applies it per session via
    // session/set_config_option. Models without support_efforts (e.g.
    // kimi-for-coding) simply get no picker, since the catalog drives the
    // frontend options. (Verified live 2026-07-29 via scripts/probe-kimi-acp.mjs.)
    supportsEffort: true,
  },
  pi: {
    provider: 'pi',
    // Pi has no built-in permission popups. "plan" maps to a read-only tool
    // allowlist (`--tools read,grep,find,ls`); everything else runs with the
    // full default tool set. bypassPermissions is the default for headless
    // chat so turns never stall.
    permissionModes: ['plan', 'bypassPermissions'],
    defaultPermissionMode: 'bypassPermissions',
    // Images accepted as base64 in RPC prompt payloads; path refs also work
    // via appendImagesInputTag for non-image files.
    supportsImages: true,
    supportsFiles: true,
    supportsAbort: true,
    // Pi philosophy: no permission popups. Extensions can add them later.
    supportsPermissionRequests: false,
    // Live sessions use RPC get_session_stats; idle sessions are read from
    // Pi's persisted JSONL usage records by the token-usage route.
    supportsTokenUsage: true,
    // Thinking level maps to Pi's real RPC control (`set_thinking_level` /
    // `--thinking` at spawn) — pi-cli.js applies it per session, gated by
    // the selected model's catalog entry (pi-models.provider surfaces the
    // "thinking" column from `pi --list-models`).
    supportsEffort: true,
  },
};

/**
 * Application service exposing the provider capability matrix.
 */
export const providerCapabilitiesService = {
  getProviderCapabilities(provider: LLMProvider): ProviderCapabilities {
    return PROVIDER_CAPABILITIES[provider];
  },

  listAllProviderCapabilities(): ProviderCapabilities[] {
    return Object.values(PROVIDER_CAPABILITIES);
  },
};
