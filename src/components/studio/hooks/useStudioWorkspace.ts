import { useEffect, useMemo, useState } from 'react';

import type { Project } from '../../../types/app';
import { studioApi } from '../api/studioApi';

import {
  createStudioWorkspaceController,
  INITIAL_STUDIO_WORKSPACE_STATE,
  type StudioWorkspaceController,
  type StudioWorkspaceState,
} from './studioWorkspaceController';

type UseStudioWorkspaceArgs = {
  selectedProject: Project | null;
  projects: Project[];
  isVisible: boolean;
};

export function useStudioWorkspace({
  selectedProject,
  projects,
  isVisible,
}: UseStudioWorkspaceArgs) {
  const [state, setState] = useState<StudioWorkspaceState>(() => ({
    ...INITIAL_STUDIO_WORKSPACE_STATE,
    projectId: selectedProject?.projectId ?? '',
  }));

  const controller = useMemo<StudioWorkspaceController>(
    () => createStudioWorkspaceController({
      api: studioApi,
      onState: setState,
      initialProjectId: selectedProject?.projectId ?? '',
    }),
    // Controller is session-long; project changes go through setProjectId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => () => controller.destroy(), [controller]);

  useEffect(() => {
    controller.setVisible(isVisible);
  }, [controller, isVisible]);

  useEffect(() => {
    const nextId = selectedProject?.projectId ?? '';
    controller.setProjectId(nextId);
  }, [controller, selectedProject?.projectId]);

  useEffect(() => {
    if (!isVisible) return;
    void controller.loadList();
  }, [controller, isVisible, state.projectId]);

  const project = useMemo(
    () => projects.find((entry) => entry.projectId === state.projectId) ?? selectedProject,
    [projects, selectedProject, state.projectId],
  );

  return {
    ...state,
    project,
    generating: state.active?.status === 'generating',
    setProjectId: controller.setProjectId,
    setDraft: controller.setDraft,
    setPendingSelection: controller.setPendingSelection,
    setFrame: controller.setFrame,
    setSelectMode: controller.setSelectMode,
    loadList: controller.loadList,
    refreshActive: controller.refreshActive,
    selectPrototype: controller.selectPrototype,
    createPrototype: controller.createPrototype,
    removePrototype: controller.removePrototype,
    submitTurn: controller.submitTurn,
    requestVariants: controller.requestVariants,
    promoteVariant: controller.promoteVariant,
    revertToVersion: controller.revertToVersion,
    applyTokens: controller.applyTokens,
    launchSwarm: controller.launchSwarm,
    ideatePrompt: controller.ideatePrompt,
  };
}

export type StudioWorkspace = ReturnType<typeof useStudioWorkspace>;
