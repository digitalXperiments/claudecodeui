import { useState } from 'react';
import { Gauge, Settings2, Wrench, Waypoints } from 'lucide-react';

import { cn } from '../../../lib/utils';
import type { Project } from '../../../types/app';

import AgentRelayMcpToolsPanel from './AgentRelayMcpToolsPanel';
import AgentRelayModelProfilesPanel from './AgentRelayModelProfilesPanel';
import AgentRelaySettingsForm from './AgentRelaySettingsForm';

type AgentRelayViewProps = {
  selectedProject: Project | null;
  isVisible: boolean;
};

export default function AgentRelayView({ selectedProject: _selectedProject, isVisible: _isVisible }: AgentRelayViewProps) {
  const [tab, setTab] = useState<'settings' | 'profiles' | 'mcp'>('settings');

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
        <div className="mt-4 flex gap-1 rounded-lg border border-border bg-muted/40 p-1">
          <button
            type="button"
            onClick={() => setTab('settings')}
            className={cn(
              'flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium',
              tab === 'settings' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Settings2 className="h-4 w-4" />
            Settings
          </button>
          <button
            type="button"
            onClick={() => setTab('profiles')}
            className={cn(
              'flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium',
              tab === 'profiles' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Gauge className="h-4 w-4" />
            Profiles
          </button>
          <button
            type="button"
            onClick={() => setTab('mcp')}
            className={cn(
              'flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium',
              tab === 'mcp' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Wrench className="h-4 w-4" />
            MCP
          </button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
        {tab === 'settings' ? (
          <AgentRelaySettingsForm />
        ) : tab === 'profiles' ? (
          <AgentRelayModelProfilesPanel />
        ) : (
          <AgentRelayMcpToolsPanel />
        )}
      </div>
    </div>
  );
}
