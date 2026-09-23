import { useState, type KeyboardEvent } from 'react';
import { Activity, Gauge, Settings2, Wrench, Waypoints, type LucideIcon } from 'lucide-react';

import { cn } from '../../../lib/utils';
import type { Project } from '../../../types/app';

import AgentRelayMcpToolsPanel from './AgentRelayMcpToolsPanel';
import AgentRelayModelProfilesPanel from './AgentRelayModelProfilesPanel';
import AgentRelaySettingsForm from './AgentRelaySettingsForm';
import AgentRelayActivityControl from '../../chat/view/subcomponents/AgentRelayActivityControl';

type AgentRelayViewProps = {
  selectedProject: Project | null;
  isVisible: boolean;
};

export default function AgentRelayView({ selectedProject, isVisible }: AgentRelayViewProps) {
  const [tab, setTab] = useState<'settings' | 'profiles' | 'mcp' | 'activity'>('settings');
  const tabs: Array<{ id: typeof tab; label: string; icon: LucideIcon }> = [
    { id: 'settings', label: 'Settings', icon: Settings2 },
    { id: 'profiles', label: 'Profiles', icon: Gauge },
    { id: 'mcp', label: 'MCP', icon: Wrench },
    { id: 'activity', label: 'Activity', icon: Activity },
  ];
  const projectId = isVisible ? selectedProject?.projectId ?? null : null;
  // ActivityControl keeps a concrete session scope so its existing “All
  // sessions” operator affordance remains available. Prefer a user session
  // over an internal worker session when the project has both.
  const activitySessionId = isVisible
    ? selectedProject?.sessions?.find((session) => !session.isInternal)?.id
      ?? selectedProject?.sessions?.[0]?.id
      ?? null
    : null;

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    setTab(tabs[nextIndex].id);
    document.getElementById(`agent-relay-tab-${tabs[nextIndex].id}`)?.focus();
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="border-b border-border px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] md:px-6">
        <div className="flex items-start gap-3 pr-12">
          <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
            <Waypoints className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-foreground">Agent Relay</h1>
            <p className="mt-0.5 max-w-3xl text-sm text-muted-foreground">
              Lead chats plan and synthesize. CloudCLI starts workers, isolates writes, and returns durable results. Agent Swarm is retired.
            </p>
          </div>
        </div>
        <div role="tablist" aria-label="Agent Relay sections" className="mt-4 grid grid-cols-2 gap-1 rounded-lg border border-border bg-muted/40 p-1 sm:grid-cols-4">
          {tabs.map(({ id, label, icon: Icon }, index) => (
            <button
              key={id}
              id={`agent-relay-tab-${id}`}
              type="button"
              role="tab"
              aria-selected={tab === id}
              aria-controls="agent-relay-panel"
              tabIndex={tab === id ? 0 : -1}
              onClick={() => setTab(id)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
              className={cn(
                'flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium',
                tab === id ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon aria-hidden="true" className="h-4 w-4" />
              {label}
            </button>
          ))}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
        <div
          id="agent-relay-panel"
          role="tabpanel"
          aria-labelledby={`agent-relay-tab-${tab}`}
          tabIndex={0}
          className="min-h-full outline-none"
        >
          {tab === 'settings' ? (
            <AgentRelaySettingsForm />
          ) : tab === 'profiles' ? (
            <AgentRelayModelProfilesPanel />
          ) : tab === 'mcp' ? (
            <AgentRelayMcpToolsPanel />
          ) : (
            <AgentRelayActivityControl projectId={projectId} sessionId={activitySessionId} embedded />
          )}
        </div>
      </div>
    </div>
  );
}
