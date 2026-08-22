import {
  STUDIO_POLL_INTERVAL_MS,
  type StudioPreviewFrame,
  type StudioPrototype,
  type StudioPrototypeDetail,
  type StudioSelectedElement,
  type StudioTokensPatch,
} from '../types';

export type StudioWorkspaceApi = {
  list: (projectId: string) => Promise<StudioPrototype[]>;
  get: (projectId: string, id: string) => Promise<StudioPrototypeDetail>;
  create: (
    projectId: string,
    input: { title?: string; brief: string; skills?: string[] },
  ) => Promise<StudioPrototypeDetail>;
  remove: (projectId: string, id: string) => Promise<void>;
  appendTurn: (
    projectId: string,
    id: string,
    input: { message: string; selectedElement?: StudioSelectedElement | null },
  ) => Promise<StudioPrototypeDetail>;
  generateVariants: (
    projectId: string,
    id: string,
    input?: { message?: string; count?: number; selectedElement?: StudioSelectedElement | null },
  ) => Promise<StudioPrototypeDetail>;
  promoteVariant: (projectId: string, id: string, variantId: string) => Promise<StudioPrototypeDetail>;
  revertToVersion: (projectId: string, id: string, versionId: string) => Promise<StudioPrototypeDetail>;
  updateTokens: (
    projectId: string,
    id: string,
    input: { tokens: StudioTokensPatch; regenerate?: boolean },
  ) => Promise<StudioPrototypeDetail>;
  launchSwarm: (
    projectId: string,
    id: string,
  ) => Promise<{ swarmId: string; prototype: StudioPrototypeDetail }>;
  ideatePrompt: (
    projectId: string,
    id: string,
  ) => Promise<{ prompt: string; prototype: StudioPrototypeDetail }>;
};

export type StudioWorkspaceState = {
  projectId: string;
  items: StudioPrototype[];
  active: StudioPrototypeDetail | null;
  draft: string;
  pendingSelection: StudioSelectedElement | null;
  frame: StudioPreviewFrame;
  selectMode: boolean;
  error: string | null;
  busy: boolean;
};

export type StudioWorkspaceControllerOptions = {
  api: StudioWorkspaceApi;
  onState: (state: StudioWorkspaceState) => void;
  pollIntervalMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  initialProjectId?: string;
};

export const INITIAL_STUDIO_WORKSPACE_STATE: StudioWorkspaceState = {
  projectId: '',
  items: [],
  active: null,
  draft: '',
  pendingSelection: null,
  frame: 'desktop',
  selectMode: false,
  error: null,
  busy: false,
};

function failMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Studio request failed';
}

function normalizeDetail(prototype: StudioPrototypeDetail): StudioPrototypeDetail {
  return {
    ...prototype,
    versions: Array.isArray(prototype.versions) ? prototype.versions : [],
    variants: Array.isArray(prototype.variants) ? prototype.variants : [],
    generation: prototype.generation ?? null,
    swarmId: prototype.swarmId ?? null,
  };
}

function mergeItems(items: StudioPrototype[], prototype: StudioPrototype): StudioPrototype[] {
  const index = items.findIndex((item) => item.id === prototype.id);
  if (index < 0) return [prototype, ...items];
  const next = items.slice();
  next[index] = prototype;
  return next;
}

export function createStudioWorkspaceController(options: StudioWorkspaceControllerOptions) {
  const api = options.api;
  const pollIntervalMs = options.pollIntervalMs ?? STUDIO_POLL_INTERVAL_MS;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;

  let state: StudioWorkspaceState = {
    ...INITIAL_STUDIO_WORKSPACE_STATE,
    projectId: options.initialProjectId ?? '',
  };
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let loadKey = 0;
  let visible = true;
  let destroyed = false;

  const emit = (patch: Partial<StudioWorkspaceState>) => {
    if (destroyed) return;
    state = { ...state, ...patch };
    options.onState(state);
    syncPoll();
  };

  const stopPoll = () => {
    if (pollTimer !== null) {
      clearIntervalFn(pollTimer);
      pollTimer = null;
    }
  };

  const syncPoll = () => {
    const shouldPoll = visible && state.active?.status === 'generating';
    if (shouldPoll && pollTimer === null) {
      pollTimer = setIntervalFn(() => {
        void refreshActive();
      }, pollIntervalMs);
    } else if (!shouldPoll) {
      stopPoll();
    }
  };

  const refreshActive = async () => {
    const current = state.active;
    if (!current) return;
    try {
      const prototype = normalizeDetail(await api.get(current.projectId, current.id));
      if (destroyed || state.active?.id !== prototype.id) return;
      emit({
        active: prototype,
        items: mergeItems(state.items, prototype),
      });
    } catch {
      // Keep the last good snapshot while a poll tick fails.
    }
  };

  const run = async <T>(work: () => Promise<T>): Promise<T | null> => {
    emit({ busy: true, error: null });
    try {
      const result = await work();
      emit({ busy: false });
      return result;
    } catch (error) {
      emit({ busy: false, error: failMessage(error) });
      return null;
    }
  };

  const loadList = async () => {
    const projectId = state.projectId;
    if (!projectId) {
      emit({ items: [], active: null });
      return;
    }
    const key = loadKey + 1;
    loadKey = key;
    try {
      const items = await api.list(projectId);
      if (destroyed || loadKey !== key) return;
      emit({
        items,
        active: state.active?.projectId === projectId ? state.active : null,
      });
    } catch (error) {
      if (destroyed || loadKey !== key) return;
      emit({ error: failMessage(error) });
    }
  };

  const selectPrototype = async (item: Pick<StudioPrototype, 'projectId' | 'id'>) => {
    await run(async () => {
      const prototype = normalizeDetail(await api.get(item.projectId, item.id));
      emit({
        active: prototype,
        pendingSelection: null,
        items: mergeItems(state.items, prototype),
      });
    });
  };

  const createPrototype = async (input: { brief: string; skills?: string[]; title?: string }) => {
    if (!state.projectId) {
      emit({ error: 'Select a project first.' });
      return null;
    }
    const brief = input.brief.trim();
    if (!brief) {
      emit({ error: 'Describe what you want to prototype.' });
      return null;
    }
    return run(async () => {
      const created = normalizeDetail(await api.create(state.projectId, {
        brief,
        skills: input.skills,
        title: input.title,
      }));
      emit({
        active: created,
        pendingSelection: null,
        items: mergeItems(state.items, created),
      });
      return created;
    });
  };

  const removePrototype = async (item: Pick<StudioPrototype, 'projectId' | 'id'>) => {
    await api.remove(item.projectId, item.id);
    const clearing = state.active?.id === item.id;
    emit({
      items: state.items.filter((entry) => entry.id !== item.id),
      active: clearing ? null : state.active,
      pendingSelection: clearing ? null : state.pendingSelection,
    });
  };

  const submitTurn = async (messageOverride?: string) => {
    const active = state.active;
    if (!active) return;
    const message = (messageOverride ?? state.draft).trim();
    if (!message) {
      emit({ error: 'Describe the change you want.' });
      return;
    }
    const selectedElement = state.pendingSelection;
    await run(async () => {
      const prototype = normalizeDetail(await api.appendTurn(active.projectId, active.id, {
        message,
        selectedElement,
      }));
      emit({
        active: prototype,
        draft: '',
        pendingSelection: null,
        items: mergeItems(state.items, prototype),
      });
    });
  };

  const requestVariants = async (count = 3) => {
    const active = state.active;
    if (!active) return;
    const message = state.draft.trim() || undefined;
    await run(async () => {
      const prototype = normalizeDetail(await api.generateVariants(active.projectId, active.id, {
        message,
        count,
        selectedElement: state.pendingSelection,
      }));
      emit({
        active: prototype,
        items: mergeItems(state.items, prototype),
      });
    });
  };

  const promoteVariant = async (variantId: string) => {
    const active = state.active;
    if (!active) return;
    await run(async () => {
      const prototype = normalizeDetail(await api.promoteVariant(active.projectId, active.id, variantId));
      emit({
        active: prototype,
        items: mergeItems(state.items, prototype),
      });
    });
  };

  const revertToVersion = async (versionId: string) => {
    const active = state.active;
    if (!active) return;
    await run(async () => {
      const prototype = normalizeDetail(await api.revertToVersion(active.projectId, active.id, versionId));
      emit({
        active: prototype,
        items: mergeItems(state.items, prototype),
      });
    });
  };

  const applyTokens = async (tokens: StudioTokensPatch) => {
    const active = state.active;
    if (!active) return;
    await run(async () => {
      const prototype = normalizeDetail(await api.updateTokens(active.projectId, active.id, {
        tokens,
        regenerate: true,
      }));
      emit({
        active: prototype,
        items: mergeItems(state.items, prototype),
      });
    });
  };

  const launchSwarm = async () => {
    const active = state.active;
    if (!active) return null;
    return run(async () => {
      const result = await api.launchSwarm(active.projectId, active.id);
      const prototype = normalizeDetail(result.prototype);
      emit({
        active: prototype,
        items: mergeItems(state.items, prototype),
      });
      return { ...result, prototype };
    });
  };

  const ideatePrompt = async () => {
    const active = state.active;
    if (!active) return null;
    return run(async () => {
      const result = await api.ideatePrompt(active.projectId, active.id);
      const prototype = normalizeDetail(result.prototype);
      emit({ active: prototype });
      return { ...result, prototype };
    });
  };

  return {
    getState: () => state,
    setProjectId: (projectId: string) => {
      if (projectId === state.projectId) return;
      emit({
        projectId,
        items: [],
        active: null,
        pendingSelection: null,
        error: null,
      });
    },
    setVisible: (next: boolean) => {
      visible = next;
      if (!visible) stopPoll();
      else syncPoll();
    },
    setDraft: (draft: string) => emit({ draft }),
    setPendingSelection: (pendingSelection: StudioSelectedElement | null) => emit({ pendingSelection }),
    setFrame: (frame: StudioPreviewFrame) => emit({ frame }),
    setSelectMode: (selectMode: boolean) => emit({ selectMode }),
    setError: (error: string | null) => emit({ error }),
    loadList,
    refreshActive,
    selectPrototype,
    createPrototype,
    removePrototype,
    submitTurn,
    requestVariants,
    promoteVariant,
    revertToVersion,
    applyTokens,
    launchSwarm,
    ideatePrompt,
    destroy: () => {
      destroyed = true;
      stopPoll();
    },
  };
}

export type StudioWorkspaceController = ReturnType<typeof createStudioWorkspaceController>;
