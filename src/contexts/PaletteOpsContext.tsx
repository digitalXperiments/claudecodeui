import { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import type { MutableRefObject, ReactNode } from 'react';

import type { Project } from '../types/app';
import type { SidebarSearchMode } from '../components/sidebar/types/types';

export type PaletteOps = {
  openFile: (path: string) => void;
  // Opens a file in the editor side panel without changing the active tab
  // (used by in-chat file links so they behave like the inline edit view).
  openFileInEditor: (path: string) => void;
  openSettings: (tab?: string) => void;
  refreshProjects: () => Promise<void> | void;
  openNeedsYou: () => void;
  openMissionControl: () => void;
  openKanban: () => void;
  openAgentSwarm: () => void;
  openStudio: () => void;
  openStats: () => void;
  openNewProject: () => void;
  setSidebarSearchMode: (mode: SidebarSearchMode) => void;
  selectProject: (project: Project) => void;
  toggleSidebarCollapsed: () => void;
};

type Registry = MutableRefObject<Partial<PaletteOps>>;

const PaletteOpsContext = createContext<Registry | null>(null);

const noop = () => undefined;

const defaultOps: PaletteOps = {
  openFile: noop,
  openFileInEditor: noop,
  openSettings: noop,
  refreshProjects: noop,
  openNeedsYou: noop,
  openMissionControl: noop,
  openKanban: noop,
  openAgentSwarm: noop,
  openStudio: noop,
  openStats: noop,
  openNewProject: noop,
  setSidebarSearchMode: noop,
  selectProject: noop,
  toggleSidebarCollapsed: noop,
};

export function PaletteOpsProvider({ children }: { children: ReactNode }) {
  const ref = useRef<Partial<PaletteOps>>({});
  return <PaletteOpsContext.Provider value={ref}>{children}</PaletteOpsContext.Provider>;
}

export function usePaletteOps(): PaletteOps {
  const ref = useContext(PaletteOpsContext);
  return useMemo<PaletteOps>(
    () => ({
      openFile: (path) => (ref?.current.openFile ?? defaultOps.openFile)(path),
      openFileInEditor: (path) =>
        (ref?.current.openFileInEditor ?? defaultOps.openFileInEditor)(path),
      openSettings: (tab) => (ref?.current.openSettings ?? defaultOps.openSettings)(tab),
      refreshProjects: () => (ref?.current.refreshProjects ?? defaultOps.refreshProjects)(),
      openNeedsYou: () => (ref?.current.openNeedsYou ?? defaultOps.openNeedsYou)(),
      openMissionControl: () => (ref?.current.openMissionControl ?? defaultOps.openMissionControl)(),
      openKanban: () => (ref?.current.openKanban ?? defaultOps.openKanban)(),
      openAgentSwarm: () => (ref?.current.openAgentSwarm ?? defaultOps.openAgentSwarm)(),
      openStudio: () => (ref?.current.openStudio ?? defaultOps.openStudio)(),
      openStats: () => (ref?.current.openStats ?? defaultOps.openStats)(),
      openNewProject: () => (ref?.current.openNewProject ?? defaultOps.openNewProject)(),
      setSidebarSearchMode: (mode) =>
        (ref?.current.setSidebarSearchMode ?? defaultOps.setSidebarSearchMode)(mode),
      selectProject: (project) => (ref?.current.selectProject ?? defaultOps.selectProject)(project),
      toggleSidebarCollapsed: () =>
        (ref?.current.toggleSidebarCollapsed ?? defaultOps.toggleSidebarCollapsed)(),
    }),
    [ref],
  );
}

export function usePaletteOpsRegister(partial: Partial<PaletteOps>) {
  const ref = useContext(PaletteOpsContext);

  useEffect(() => {
    if (!ref) return undefined;
    const prev = { ...ref.current };
    const keys = Object.keys(partial) as (keyof PaletteOps)[];
    for (const key of keys) {
      const value = partial[key];
      if (value) {
        (ref.current as Record<string, unknown>)[key] = value;
      }
    }
    return () => {
      for (const key of keys) {
        if (ref.current[key] === partial[key]) {
          (ref.current as Record<string, unknown>)[key] = prev[key];
        }
      }
    };
  }, [ref, partial]);
}
