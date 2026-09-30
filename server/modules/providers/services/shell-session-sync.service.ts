import { syncClaudeShellSession } from '@/modules/providers/list/claude/claude-shell-sync.js';
import { syncCodexShellSession } from '@/modules/providers/list/codex/codex-shell-sync.js';
import { syncGrokShellSession } from '@/modules/providers/list/grok/grok-shell-sync.js';
import { syncOpenCodeShellSession } from '@/modules/providers/list/opencode/opencode-shell-sync.js';

export type ShellSessionSyncInfo = {
  provider: string;
  projectPath: string;
  appSessionId: string | null;
  /** When the shell PTY spawned (epoch ms). */
  startedAt: number;
  /** When the PTY exited / adoption was requested (epoch ms); bounds candidates. */
  endedAt?: number;
  /**
   * Prompts submitted into the PTY. Adopting a never-linked session requires
   * the candidate transcript to contain one (see adoptShellCreatedSession).
   */
  submittedPrompts?: readonly string[];
};

/**
 * Per-provider adopter for sessions an interactive Shell TUI created or
 * resumed. Resolves to the canonical app session id to broadcast an upsert
 * for (so open chat views refetch the turns the shell wrote), or null when
 * the provider has no adopter or nothing belongs to this shell.
 */
export async function syncShellSessionForProvider(info: ShellSessionSyncInfo): Promise<string | null> {
  const { provider, ...rest } = info;
  const adopter = provider === 'grok'
    ? syncGrokShellSession
    : provider === 'codex'
      ? syncCodexShellSession
      : provider === 'claude'
        ? syncClaudeShellSession
        : provider === 'opencode'
          ? syncOpenCodeShellSession
          : null;
  if (!adopter) {
    return null;
  }
  const result = await adopter(rest);
  return result?.appSessionId ?? null;
}

// Runtime readers the shell websocket polls, re-exported so it has a single
// entry point into the providers module.
export {
  readClaudeShellRuntime,
  resolveClaudeShellTranscript,
} from '@/modules/providers/list/claude/claude-shell-sync.js';
export { readCodexShellRuntime } from '@/modules/providers/list/codex/codex-shell-sync.js';
export {
  readGrokSessionRuntime,
  readLatestGrokSessionRuntime,
} from '@/modules/providers/list/grok/grok-shell-sync.js';
export { readOpenCodeShellRuntime } from '@/modules/providers/list/opencode/opencode-shell-sync.js';
