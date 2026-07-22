import type { LLMProvider } from '../../../types/app';
import type { PermissionMode } from '../types/types';

/**
 * Human-facing labels + descriptions for the chatbar permission-mode button.
 *
 * Descriptions are written against what each CloudCLI runtime actually does
 * (see server/*-cli.js / claude-sdk.js / openai-codex.js and
 * provider-capabilities.service.ts), not generic Codex copy.
 */
export type PermissionModeCopy = {
  label: string;
  /** Short one-liner for the tooltip title line. */
  summary: string;
  /** What the underlying CLI/SDK flag or config does. */
  technical?: string;
};

/** Shared labels shown on the button itself. */
export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  default: 'Default',
  auto: 'Auto',
  acceptEdits: 'Accept Edits',
  bypassPermissions: 'Bypass Permissions',
  plan: 'Plan',
};

/**
 * Per-provider mode explanations. Only modes listed for a provider in
 * provider-capabilities should appear in the cycle; copy for unused modes is
 * still defined so fallbacks stay readable.
 */
export const PERMISSION_MODE_COPY: Record<
  LLMProvider,
  Partial<Record<PermissionMode, PermissionModeCopy>>
> = {
  claude: {
    default: {
      label: 'Default',
      summary: 'Prompt before tools that need approval (standard Claude Code behavior).',
      technical: 'SDK default permission mode (no --permission-mode override).',
    },
    auto: {
      label: 'Auto',
      summary: 'A model classifier approves safe tool calls; risky ones may still prompt.',
      technical: '--permission-mode auto',
    },
    acceptEdits: {
      label: 'Accept Edits',
      summary: 'Auto-approve file edits; other tools may still ask for permission.',
      technical: '--permission-mode acceptEdits',
    },
    bypassPermissions: {
      label: 'Bypass Permissions',
      summary: 'Skip permission prompts for tool use. Use only in trusted workspaces.',
      technical: '--permission-mode bypassPermissions / --dangerously-skip-permissions',
    },
    plan: {
      label: 'Plan',
      summary: 'Read-only planning — explore and draft a plan without implementing.',
      technical: '--permission-mode plan',
    },
  },
  cursor: {
    // Cursor agent headless path only supports default vs force (-f).
    default: {
      label: 'Default',
      summary: 'Normal Cursor permissions (may prompt or block untrusted actions).',
      technical: 'cursor-agent without -f',
    },
    bypassPermissions: {
      label: 'Bypass Permissions',
      summary: 'Force-approve / skip permission checks for this run.',
      technical: 'cursor-agent -f',
    },
  },
  codex: {
    default: {
      label: 'Default',
      summary: 'Workspace write sandbox; only trusted commands auto-run, others need approval.',
      technical: 'sandboxMode=workspace-write, approvalPolicy=untrusted',
    },
    acceptEdits: {
      label: 'Accept Edits',
      summary: 'Workspace write sandbox with no approval prompts for commands in the project.',
      technical: 'sandboxMode=workspace-write, approvalPolicy=never',
    },
    bypassPermissions: {
      label: 'Bypass Permissions',
      summary: 'Full disk/network access with no approval prompts. Use with caution.',
      technical: 'sandboxMode=danger-full-access, approvalPolicy=never',
    },
  },
  opencode: {
    default: {
      label: 'Default',
      summary: 'OpenCode’s normal permission handling for the selected agent.',
      technical: 'No --auto / --agent plan override',
    },
    acceptEdits: {
      label: 'Accept Edits',
      summary: 'Auto-allow file edits; other permissions follow OpenCode defaults.',
      technical: 'OPENCODE_PERMISSION={"edit":"allow"}',
    },
    bypassPermissions: {
      label: 'Bypass Permissions',
      summary: 'Auto-approve permissions that are not explicitly denied.',
      technical: 'opencode --auto',
    },
    plan: {
      label: 'Plan',
      summary: 'Use OpenCode’s read-only plan agent.',
      technical: 'opencode --agent plan',
    },
  },
  grok: {
    default: {
      label: 'Default',
      summary: 'Prompt for tools that are not pre-approved (reads/safe shell may auto-run).',
      technical: '[ui] permission_mode = "default"',
    },
    acceptEdits: {
      label: 'Accept Edits',
      summary: 'Auto-approve file edits; shell and other tools may still prompt.',
      technical: '[ui] permission_mode = "acceptEdits"',
    },
    auto: {
      label: 'Auto',
      summary: 'Classifier approves safe tools; dangerous actions may still prompt.',
      technical: '[ui] permission_mode = "auto" (not the same as always-approve)',
    },
    bypassPermissions: {
      label: 'Bypass Permissions',
      summary: 'Always-approve — auto-run tools without permission prompts.',
      technical: '--always-approve + permission_mode = "always-approve"',
    },
    plan: {
      label: 'Plan',
      summary: 'Plan mode — focus on planning; non-plan edits are restricted.',
      technical: '[ui] permission_mode = "plan"',
    },
  },
  kimi: {
    default: {
      label: 'Default',
      summary: 'Prompt for tool permission over ACP before executing.',
      technical: 'Kimi ACP mode = default',
    },
    plan: {
      label: 'Plan',
      summary: 'Plan mode — restricted execution with permission checks.',
      technical: 'Kimi ACP mode = plan',
    },
    auto: {
      label: 'Auto',
      summary: 'Auto permission mode — fewer prompts than default (Kimi “auto”).',
      technical: 'Kimi ACP mode = auto',
    },
    bypassPermissions: {
      label: 'Bypass Permissions',
      summary: 'YOLO — automatically approve all actions.',
      technical: 'Kimi ACP mode = yolo',
    },
  },
  agy: {
    plan: {
      label: 'Plan',
      summary: 'Read-only planning mode (no edits or shell).',
      technical: 'agy --mode plan',
    },
    acceptEdits: {
      label: 'Accept Edits',
      summary: 'Auto-accept file edits; other tools may still prompt (can stall headless).',
      technical: 'agy --mode accept-edits',
    },
    bypassPermissions: {
      label: 'Bypass Permissions',
      summary: 'Auto-approve every tool permission request (recommended for headless chat).',
      technical: 'agy --dangerously-skip-permissions',
    },
  },
};

export function getPermissionModeCopy(
  provider: LLMProvider,
  mode: PermissionMode | string,
): PermissionModeCopy {
  const key = mode as PermissionMode;
  const providerCopy = PERMISSION_MODE_COPY[provider]?.[key];
  if (providerCopy) {
    return providerCopy;
  }
  return {
    label: PERMISSION_MODE_LABELS[key] || String(mode),
    summary: 'Permission mode for this agent.',
  };
}

export function formatPermissionModeTooltip(
  provider: LLMProvider,
  mode: PermissionMode | string,
  clickHint: string,
): string {
  const copy = getPermissionModeCopy(provider, mode);
  const lines = [
    `${copy.label}`,
    copy.summary,
  ];
  if (copy.technical) {
    lines.push(copy.technical);
  }
  lines.push(clickHint);
  return lines.join('\n');
}
