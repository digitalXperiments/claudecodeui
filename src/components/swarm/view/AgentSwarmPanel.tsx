import { X } from 'lucide-react';

import { Button } from '../../../shared/view/ui';
import type { Project } from '../../../types/app';
import ErrorBoundary from '../../main-content/view/ErrorBoundary';

import AgentSwarmView from './AgentSwarmView';

type AgentSwarmPanelProps = {
  isOpen: boolean;
  onClose: () => void;
  selectedProject: Project | null;
  projects?: Project[];
};

/**
 * Global Agent Swarm shell — opened from the left sidebar rail (like Kanban / Mission Control).
 */
export default function AgentSwarmPanel({
  isOpen,
  onClose,
  selectedProject,
  projects = [],
}: AgentSwarmPanelProps) {
  if (!isOpen) return null;

  return (
    <div
      className="modal-backdrop fixed inset-0 z-[9999] flex items-stretch justify-center bg-background md:items-center md:bg-background/80 md:p-4 md:backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative flex h-dvh max-h-dvh w-full flex-col overflow-hidden border-0 bg-background shadow-none md:h-[92vh] md:max-h-[92vh] md:max-w-[min(1400px,96vw)] md:rounded-xl md:border md:border-border md:shadow-2xl">
        <div className="absolute right-2 top-[max(0.5rem,env(safe-area-inset-top))] z-10 md:right-3 md:top-2.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="h-10 w-10 touch-manipulation p-0 text-muted-foreground hover:text-foreground active:bg-accent/50 md:h-9 md:w-9"
            aria-label="Close Agent Swarm"
          >
            <X className="h-5 w-5 md:h-4 md:w-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden pb-safe-area-inset-bottom">
          <ErrorBoundary showDetails>
            <AgentSwarmView selectedProject={selectedProject} projects={projects} isVisible={isOpen} />
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}
