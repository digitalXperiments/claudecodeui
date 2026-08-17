import {
  Activity,
  AlertTriangle,
  Archive,
  BarChart3,
  Bug,
  CircleAlert,
  Folder,
  History,
  PanelLeftClose,
  PanelLeftOpen,
  Radar,
  Search,
  Settings,
  Network,
  Sparkles,
  SquareKanban,
  Palette,
} from 'lucide-react';
import type { TFunction } from 'i18next';

import { Tooltip } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';
import type { SidebarSearchMode } from '../../types/types';

const DISCORD_INVITE_URL = 'https://discord.gg/buxwujPNRE';
const GITHUB_ISSUES_URL = 'https://github.com/siteboon/claudecodeui/issues/new';

function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  );
}

type SidebarRailProps = {
  searchMode: SidebarSearchMode;
  onSearchModeChange: (mode: SidebarSearchMode) => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  runningSessionsCount: number;
  onShowKanban?: () => void;
  onShowAgentSwarm: () => void;
  onShowStudio: () => void;
  studioActive?: boolean;
  onShowMissionControl: () => void;
  missionControlPendingCount: number;
  onShowStats: () => void;
  onShowNeedsYou: () => void;
  needsYouCount: number;
  onShowSettings: () => void;
  updateAvailable: boolean;
  restartRequired: boolean;
  onShowVersionModal: () => void;
  t: TFunction;
};

function RailButton({
  active,
  onClick,
  title,
  children,
  badge,
}: {
  active?: boolean;
  onClick?: () => void;
  title: string;
  children: React.ReactNode;
  badge?: number | boolean;
}) {
  const showNumber = typeof badge === 'number' && badge > 0;
  const showDot = badge === true || showNumber;

  return (
    <Tooltip content={title} position="right">
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'group relative flex h-10 w-10 items-center justify-center rounded-xl transition-colors',
          active
            ? 'bg-primary/10 text-primary'
            : 'text-muted-foreground hover:bg-accent/80 hover:text-foreground',
        )}
      >
        {children}
        {showDot && (
          <span
            className={cn(
              'absolute right-1 top-1 flex items-center justify-center rounded-full text-[9px] font-semibold leading-none text-white',
              showNumber
                ? 'h-4 min-w-4 bg-emerald-500 px-0.5'
                : 'h-2 w-2 bg-emerald-500',
            )}
          >
            {showNumber ? (badge > 99 ? '99+' : badge) : null}
          </span>
        )}
      </button>
    </Tooltip>
  );
}

export default function SidebarRail({
  searchMode,
  onSearchModeChange,
  isCollapsed,
  onToggleCollapse,
  runningSessionsCount,
  onShowKanban,
  onShowAgentSwarm,
  onShowStudio,
  studioActive = false,
  onShowMissionControl,
  missionControlPendingCount,
  onShowStats,
  onShowNeedsYou,
  needsYouCount,
  onShowSettings,
  updateAvailable,
  restartRequired,
  onShowVersionModal,
  t,
}: SidebarRailProps) {
  return (
    <nav
      className="flex h-full w-14 flex-col items-center gap-1 border-r border-border/50 bg-background/80 py-2 backdrop-blur-sm"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0)' }}
    >
      <RailButton title={isCollapsed ? t('tooltips.showSidebar') : t('tooltips.hideSidebar')} onClick={onToggleCollapse}>
        {isCollapsed ? (
          <PanelLeftOpen className="h-[18px] w-[18px]" />
        ) : (
          <PanelLeftClose className="h-[18px] w-[18px]" />
        )}
      </RailButton>

      <div className="nav-divider my-1 w-8" />

      <RailButton
        active={searchMode === 'projects'}
        title={t('search.modeProjects')}
        onClick={() => onSearchModeChange('projects')}
      >
        <Folder className="h-[18px] w-[18px]" />
      </RailButton>

      <RailButton
        active={searchMode === 'recent'}
        title={t('search.recentTooltip', { defaultValue: 'Recent conversations' })}
        onClick={() => onSearchModeChange('recent')}
      >
        <History className="h-[18px] w-[18px]" />
      </RailButton>

      <RailButton
        active={searchMode === 'running'}
        title={t('search.runningTooltip', { defaultValue: 'Running sessions' })}
        onClick={() => onSearchModeChange('running')}
        badge={runningSessionsCount}
      >
        <Activity className="h-[18px] w-[18px]" />
      </RailButton>

      <RailButton
        active={searchMode === 'conversations'}
        title={t('search.conversationsPlaceholder')}
        onClick={() => onSearchModeChange('conversations')}
      >
        <Search className="h-[18px] w-[18px]" />
      </RailButton>

      <RailButton
        active={searchMode === 'archived'}
        title={t('search.archiveOnlyTooltip', { defaultValue: 'Archive only' })}
        onClick={() => onSearchModeChange('archived')}
      >
        <Archive className="h-[18px] w-[18px]" />
      </RailButton>

      <div className="nav-divider my-1 w-8" />

      {onShowKanban ? (
        <RailButton title={t('actions.kanban', { defaultValue: 'Kanban' })} onClick={onShowKanban}>
          <SquareKanban className="h-[18px] w-[18px]" />
        </RailButton>
      ) : null}

      <RailButton
        title={t('actions.agentSwarm', { defaultValue: 'Agent Swarm' })}
        onClick={onShowAgentSwarm}
      >
        <Network className="h-[18px] w-[18px]" />
      </RailButton>

      <RailButton
        active={studioActive}
        title={t('actions.studio', { defaultValue: 'Studio' })}
        onClick={onShowStudio}
      >
        <Palette className="h-[18px] w-[18px]" />
      </RailButton>

      <RailButton
        title={t('actions.missionControl', { defaultValue: 'Mission Control' })}
        onClick={onShowMissionControl}
        badge={missionControlPendingCount > 0 ? missionControlPendingCount : false}
      >
        <Radar className="h-[18px] w-[18px]" />
      </RailButton>

      <RailButton
        title={t('actions.stats', { defaultValue: 'Usage Stats' })}
        onClick={onShowStats}
      >
        <BarChart3 className="h-[18px] w-[18px]" />
      </RailButton>

      <RailButton
        title={t('actions.needsYou', { defaultValue: 'Needs you' })}
        onClick={onShowNeedsYou}
        badge={needsYouCount > 0 ? needsYouCount : false}
      >
        <CircleAlert className="h-[18px] w-[18px]" />
      </RailButton>

      <RailButton title={t('actions.settings')} onClick={onShowSettings}>
        <Settings className="h-[18px] w-[18px]" />
      </RailButton>

      <div className="flex-1" />

      <div className="nav-divider my-1 w-8" />

      <a
        href={GITHUB_ISSUES_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="group flex h-10 w-10 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-accent/80 hover:text-foreground"
        aria-label={t('actions.reportIssue')}
        title={t('actions.reportIssue')}
      >
        <Bug className="h-[18px] w-[18px]" />
      </a>

      <a
        href={DISCORD_INVITE_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="group flex h-10 w-10 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-accent/80 hover:text-foreground"
        aria-label={t('actions.joinCommunity')}
        title={t('actions.joinCommunity')}
      >
        <DiscordIcon className="h-[18px] w-[18px]" />
      </a>

      {restartRequired && (
        <Tooltip content={t('version.restartRequired')} position="right">
          <div className="relative flex h-10 w-10 items-center justify-center rounded-xl text-amber-500">
            <span className="absolute right-1 top-1 h-2 w-2 animate-pulse rounded-full bg-amber-500" />
            <AlertTriangle className="h-[18px] w-[18px]" />
          </div>
        </Tooltip>
      )}

      {updateAvailable && (
        <RailButton title={t('version.updateAvailable')} onClick={onShowVersionModal}>
          <span className="relative flex h-[18px] w-[18px] items-center justify-center">
            <span className="absolute right-0 top-0 h-2 w-2 animate-pulse rounded-full bg-blue-500" />
            <Sparkles className="h-[18px] w-[18px] text-blue-500" />
          </span>
        </RailButton>
      )}
    </nav>
  );
}
