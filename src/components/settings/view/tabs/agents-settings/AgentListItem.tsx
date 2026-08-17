import { cn } from '../../../../../lib/utils';
import SessionProviderLogo from '../../../../llm-logo-provider/SessionProviderLogo';
import { AGENT_NAMES } from '../../../constants/constants';
import type { AgentProvider, AuthStatus } from '../../../types/types';

type AgentListItemProps = {
  agentId: AgentProvider;
  authStatus: AuthStatus;
  isSelected: boolean;
  isEnabled: boolean;
  inChatLabel: string;
  hiddenLabel: string;
  connectedLabel: string;
  offlineLabel: string;
  onClick: () => void;
};

const DOT_COLOR: Record<AgentProvider, string> = {
  claude: 'bg-blue-500',
  cursor: 'bg-purple-500',
  opencode: 'bg-zinc-500',
  kilo: 'bg-orange-500',
  cline: 'bg-cyan-500',
  grok: 'bg-amber-500',
  kimi: 'bg-emerald-500',
  qwencode: 'bg-sky-500',
  pi: 'bg-violet-500',
  codex: 'bg-foreground/60',
};

export default function AgentListItem({
  agentId,
  authStatus,
  isSelected,
  isEnabled,
  inChatLabel,
  hiddenLabel,
  connectedLabel,
  offlineLabel,
  onClick,
}: AgentListItemProps) {
  const visibility = isEnabled ? inChatLabel : hiddenLabel;
  const authLabel = authStatus.authenticated ? connectedLabel : offlineLabel;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={isSelected ? 'true' : undefined}
      className={cn(
        'flex w-full min-w-0 touch-manipulation items-center gap-2 rounded-md px-2 py-2 text-left transition-colors duration-150',
        isSelected
          ? 'bg-muted text-foreground'
          : 'text-foreground hover:bg-muted/60',
        !isEnabled && !isSelected && 'opacity-60',
      )}
    >
      <SessionProviderLogo provider={agentId} className="h-4 w-4 flex-shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{AGENT_NAMES[agentId]}</span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {visibility} · {authLabel}
        </span>
      </span>
      {authStatus.authenticated ? (
        <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${DOT_COLOR[agentId]}`} />
      ) : authStatus.loading ? (
        <span className="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-muted-foreground/30" />
      ) : (
        <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-muted-foreground/25" />
      )}
    </button>
  );
}
