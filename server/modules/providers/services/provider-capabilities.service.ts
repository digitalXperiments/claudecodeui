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
  /** Whether inline image attachments (base64/local_image, i.e. real vision)
   * can be included in a chat.send. */
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
 * - only the Claude SDK integration surfaces interactive permission requests.
 * - Cursor has no token usage endpoint support (its store.db has no usage rows).
 */
const PROVIDER_CAPABILITIES: Record<LLMProvider, ProviderCapabilities> = {
  claude: {
    provider: 'claude',
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
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
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
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions'],
    defaultPermissionMode: 'default',
    supportsImages: true,
    supportsFiles: true,
    supportsAbort: true,
    supportsPermissionRequests: false,
    supportsTokenUsage: true,
    supportsEffort: true,
  },
  opencode: {
    provider: 'opencode',
    // Mapped by the runtime onto OpenCode's controls: `--agent plan` (plan),
    // `--auto` (bypassPermissions) and the OPENCODE_PERMISSION env var
    // (acceptEdits). See resolveOpenCodePermissionOptions in opencode-cli.js.
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
    defaultPermissionMode: 'default',
    supportsImages: true,
    supportsFiles: true,
    supportsAbort: true,
    supportsPermissionRequests: false,
    supportsTokenUsage: true,
    supportsEffort: true,
  },
  grok: {
    provider: 'grok',
    // grok-cli.js runs Grok over ACP (`grok agent stdio`). Modes map to a
    // CloudCLI-managed GROK_HOME config (`[ui] permission_mode`) plus optional
    // `--always-approve`. Interactive `session/request_permission` works when
    // not in bypass — see grok-cli.js permission bridge (verified live).
    // CLI vocabulary: default | acceptEdits | auto | bypassPermissions | plan.
    permissionModes: ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'plan'],
    defaultPermissionMode: 'default',
    supportsImages: false,
    supportsFiles: true,
    supportsAbort: true,
    supportsPermissionRequests: true,
    // Real per-turn usage lives in the session's updates.jsonl
    // (turn_completed events) and is summed by the /token-usage route.
    supportsTokenUsage: true,
    supportsEffort: true,
  },
  agy: {
    provider: 'agy',
    // Antigravity's headless `agy --print` mode maps these to real flags in
    // agy-cli.js: plan -> --mode plan (read-only), acceptEdits -> --mode
    // accept-edits (auto-accept edits; other tools may still prompt), and
    // bypassPermissions -> --dangerously-skip-permissions (auto-approve all).
    // bypassPermissions is the default because it is the only mode guaranteed
    // never to stall waiting on an approval a spawned process cannot answer.
    permissionModes: ['plan', 'acceptEdits', 'bypassPermissions'],
    defaultPermissionMode: 'bypassPermissions',
    supportsImages: false,
    supportsFiles: true,
    supportsAbort: true,
    supportsPermissionRequests: false,
    // Antigravity persists usage inside a protobuf conversation store with no
    // public schema, so there is no readable per-session token usage to expose.
    supportsTokenUsage: false,
    // Reasoning effort is baked into the model label ("... (Medium/High/Low)")
    // rather than passed as a separate flag, so there is no effort dimension.
    supportsEffort: false,
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
    supportsImages: false,
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
    // The "thinking" configOption only ever showed a single "on" value in
    // live testing, even after switching to the k3 model (whose catalog
    // entry separately advertises supportEfforts low/high/max) - no working
    // per-invocation effort control was found via ACP, so left false rather
    // than claiming unverified support.
    supportsEffort: false,
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
