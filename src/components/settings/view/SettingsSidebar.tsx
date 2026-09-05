import { useMemo, useState } from 'react';
import {
  Bell,
  Bot,
  BrainCircuit,
  ChevronDown,
  ChevronRight,
  FileCode2,
  FlaskConical,
  GitBranch,
  Info,
  Key,
  KeyRound,
  ListChecks,
  Mic,
  MonitorPlay,
  Palette,
  Puzzle,
  Route,
  Search,
  Server,
  ShieldCheck,
  UserCog,
  Webhook,
  Archive,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../lib/utils';
import { IS_PLATFORM } from '../../../constants/config';
import type { SettingsMainTab } from '../types/types';

type SettingsSidebarProps = {
  activeTab: SettingsMainTab;
  onChange: (tab: SettingsMainTab) => void;
};

type NavItem = {
  id: SettingsMainTab;
  labelKey: string;
  /** Fallback label when i18n key is missing. */
  fallbackLabel: string;
  keywords?: string;
  icon: typeof Bot;
};

type NavGroup = {
  label: string;
  items: NavItem[];
};

const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Agents & intelligence',
    items: [
      { id: 'agents', labelKey: 'mainTabs.agents', fallbackLabel: 'Agents', keywords: 'providers login models permissions', icon: Bot },
      { id: 'agent-profiles', labelKey: 'mainTabs.agentProfiles', fallbackLabel: 'Agent profiles', keywords: 'presets roles swarm', icon: UserCog },
      { id: 'continuity', labelKey: 'mainTabs.continuity', fallbackLabel: 'Continuity', keywords: 'resume limits fallback handoff retry', icon: Route },
      { id: 'studio', labelKey: 'mainTabs.studio', fallbackLabel: 'Studio', keywords: 'design prototype', icon: Palette },
      { id: 'evals', labelKey: 'mainTabs.evals', fallbackLabel: 'Eval Center', keywords: 'tests evaluation quality', icon: FlaskConical },
    ],
  },
  {
    label: 'Context & tools',
    items: [
      { id: 'mcp', labelKey: 'mainTabs.mcpServers', fallbackLabel: 'MCP', keywords: 'servers tools integrations', icon: Server },
      { id: 'skills', labelKey: 'mainTabs.skills', fallbackLabel: 'Skills', keywords: 'instructions skill md', icon: FileCode2 },
      { id: 'memory', labelKey: 'mainTabs.memory', fallbackLabel: 'Memory', keywords: 'obsidian vault context', icon: BrainCircuit },
    ],
  },
  {
    label: 'Workspace',
    items: [
      { id: 'appearance', labelKey: 'mainTabs.appearance', fallbackLabel: 'Appearance', keywords: 'theme language display', icon: Palette },
      { id: 'git', labelKey: 'mainTabs.git', fallbackLabel: 'Git', keywords: 'github commits source control', icon: GitBranch },
      { id: 'tasks', labelKey: 'mainTabs.tasks', fallbackLabel: 'Tasks', keywords: 'taskmaster planning', icon: ListChecks },
      { id: 'browser', labelKey: 'mainTabs.browser', fallbackLabel: 'Browser', keywords: 'playwright chromium automation', icon: MonitorPlay },
      { id: 'voice', labelKey: 'mainTabs.voice', fallbackLabel: 'Voice', keywords: 'speech microphone audio', icon: Mic },
    ],
  },
  {
    label: 'App & security',
    items: [
      { id: 'api', labelKey: 'mainTabs.apiTokens', fallbackLabel: 'API & Tokens', keywords: 'keys credentials github', icon: Key },
      { id: 'secrets', labelKey: 'mainTabs.secrets', fallbackLabel: 'Secrets', keywords: 'vault environment credentials', icon: KeyRound },
      { id: 'webhooks', labelKey: 'mainTabs.webhooks', fallbackLabel: 'Webhooks', keywords: 'hooks ingest automation', icon: Webhook },
      { id: 'plugins', labelKey: 'mainTabs.plugins', fallbackLabel: 'Plugins', keywords: 'extensions apps', icon: Puzzle },
      { id: 'notifications', labelKey: 'mainTabs.notifications', fallbackLabel: 'Notifications', keywords: 'alerts push desktop', icon: Bell },
      { id: 'backups', labelKey: 'mainTabs.backups', fallbackLabel: 'Backups', keywords: 'backup restore database codebase cron schedule archive', icon: Archive },
      ...(!IS_PLATFORM
        ? [{ id: 'security', labelKey: 'mainTabs.security', fallbackLabel: 'Security', keywords: '2fa totp password', icon: ShieldCheck } as NavItem]
        : []),
      { id: 'about', labelKey: 'mainTabs.about', fallbackLabel: 'About', keywords: 'version updates', icon: Info },
    ],
  },
];

const ALL_NAV_ITEMS = NAV_GROUPS.flatMap((group) => group.items);

export default function SettingsSidebar({ activeTab, onChange }: SettingsSidebarProps) {
  const { t } = useTranslation('settings');
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLowerCase();

  const visibleGroups = useMemo(() => {
    if (!normalizedQuery) return NAV_GROUPS;
    return NAV_GROUPS
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => {
          const label = t(item.labelKey, { defaultValue: item.fallbackLabel });
          return `${label} ${item.keywords ?? ''}`.toLowerCase().includes(normalizedQuery);
        }),
      }))
      .filter((group) => group.items.length > 0);
  }, [normalizedQuery, t]);

  const activeItem = ALL_NAV_ITEMS.find((item) => item.id === activeTab) ?? ALL_NAV_ITEMS[0];
  const ActiveIcon = activeItem.icon;

  return (
    <>
      <aside className="hidden w-64 flex-shrink-0 border-r border-border/70 bg-muted/20 md:flex md:min-h-0 md:flex-col">
        <div className="border-b border-border/60 p-3">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find a setting…"
              aria-label="Find a setting"
              className="h-9 w-full rounded-lg border border-border/70 bg-background/80 pl-9 pr-3 text-sm outline-none transition focus:border-primary/40 focus:ring-2 focus:ring-primary/10"
            />
          </label>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3" aria-label="Settings sections">
          {visibleGroups.length === 0 ? (
            <div className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
              No settings match “{query}”.
            </div>
          ) : (
            visibleGroups.map((group, groupIndex) => (
              <div key={group.label} className={cn(groupIndex > 0 && 'mt-5')}>
                <p className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
                  {group.label}
                </p>
                <div className="space-y-0.5">
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    const isActive = activeTab === item.id;

                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => onChange(item.id)}
                        aria-current={isActive ? 'page' : undefined}
                        className={cn(
                          'group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors duration-150',
                          isActive
                            ? 'bg-foreground text-background shadow-sm'
                            : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground active:bg-accent',
                        )}
                      >
                        <span className={cn(
                          'flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition-colors',
                          isActive
                            ? 'border-background/15 bg-background/10'
                            : 'border-border/60 bg-background/70 group-hover:border-border',
                        )}>
                          <Icon className="h-3.5 w-3.5" />
                        </span>
                        <span className="min-w-0 flex-1 truncate font-medium">
                          {t(item.labelKey, { defaultValue: item.fallbackLabel })}
                        </span>
                        {isActive && <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-60" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </nav>
      </aside>

      <div className="flex-shrink-0 border-b border-border/70 bg-muted/20 p-3 md:hidden">
        <label className="relative flex items-center">
          <span className="pointer-events-none absolute left-3 flex items-center">
            <ActiveIcon className="h-4 w-4 text-muted-foreground" />
          </span>
          <select
            value={activeTab}
            onChange={(event) => onChange(event.target.value as SettingsMainTab)}
            aria-label="Settings section"
            className="h-11 w-full appearance-none rounded-xl border border-border bg-background pl-10 pr-10 text-sm font-medium outline-none focus:ring-2 focus:ring-ring"
          >
            {NAV_GROUPS.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {t(item.labelKey, { defaultValue: item.fallbackLabel })}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-3 h-4 w-4 text-muted-foreground" />
        </label>
      </div>
    </>
  );
}
