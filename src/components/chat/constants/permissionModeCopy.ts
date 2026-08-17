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
    auto: {
      label: 'Auto',
      summary: 'A model reviews requested actions; safe ones run automatically and uncertain ones can prompt here.',
      technical: 'sandboxMode=workspace-write, approvalPolicy=on-request, approvalsReviewer=auto_review',
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
      summary: 'Prompt for edits, shell, web fetch and access outside the workspace.',
      technical: 'OpenCode ACP mode = build + OPENCODE_PERMISSION ask',
    },
    acceptEdits: {
      label: 'Accept Edits',
      summary: 'Auto-allow file edits; shell, web fetch and outside-workspace access still prompt.',
      technical: 'OPENCODE_PERMISSION={"edit":"allow", …:"ask"}',
    },
    auto: {
      label: 'Auto',
      summary: 'Approve prompts automatically. Your own OpenCode deny rules still block.',
      technical: 'OpenCode ACP mode = build, approvals answered automatically',
    },
    plan: {
      label: 'Plan',
      summary: 'OpenCode’s read-only plan agent; anything it does need is still asked for.',
      technical: 'OpenCode ACP mode = plan + OPENCODE_PERMISSION ask',
    },
  },
  kilo: {
    default: {
      label: 'Default',
      summary: 'Prompt for edits, shell, web fetch and access outside the workspace.',
      technical: 'Kilo Code ACP mode = build + KILO_PERMISSION ask',
    },
    acceptEdits: {
      label: 'Accept Edits',
      summary: 'Auto-allow file edits; shell, web fetch and outside-workspace access still prompt.',
      technical: 'KILO_PERMISSION={"edit":"allow", …:"ask"}',
    },
    auto: {
      label: 'Auto',
      summary: 'Approve prompts automatically. Kilo Code deny rules still apply.',
      technical: 'Kilo Code ACP mode = build, approvals answered automatically',
    },
    bypassPermissions: {
      label: 'Bypass Permissions',
      summary: 'Approve ACP permission requests automatically for this run.',
      technical: 'Kilo Code ACP mode = build, CloudCLI auto-approves requests',
    },
    plan: {
      label: 'Plan',
      summary: 'Kilo Code’s read-only plan agent; anything it needs is still asked for.',
      technical: 'Kilo Code ACP mode = plan + KILO_PERMISSION ask',
    },
  },
  cline: {
    default: {
      label: 'Default',
      summary: 'Use Cline’s normal ACP permission flow.',
      technical: 'cline --acp with CloudCLI approval requests',
    },
    auto: {
      label: 'Auto',
      summary: 'Automatically approve Cline tool requests for this run.',
      technical: 'CloudCLI ACP approval bridge auto-approves requests',
    },
    bypassPermissions: {
      label: 'Bypass Permissions',
      summary: 'Skip Cline permission prompts for this run.',
      technical: 'CloudCLI ACP approval bridge auto-approves requests',
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
  qwencode: {
    default: { label: 'Default', summary: 'Ask before Qwen Code runs tools that require approval.', technical: 'Qwen ACP mode = default' },
    plan: { label: 'Plan', summary: 'Plan and inspect without making normal implementation changes.', technical: 'Qwen ACP mode = plan' },
    auto: { label: 'Auto', summary: 'Approve Qwen Code tool requests automatically for this session.', technical: 'Qwen ACP mode = auto' },
    bypassPermissions: { label: 'Bypass Permissions', summary: 'Qwen Code yolo mode — automatically approve actions.', technical: 'Qwen ACP mode = yolo' },
  },
  pi: {
    plan: {
      label: 'Plan',
      summary: 'Read-only tools only (read, grep, find, ls).',
      technical: 'pi --tools read,grep,find,ls',
    },
    bypassPermissions: {
      label: 'Full tools',
      summary: 'All built-in tools (read, write, edit, bash). Pi has no permission popups.',
      technical: 'pi (default tool set)',
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
