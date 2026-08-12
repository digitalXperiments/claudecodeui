import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import { findProviderModelOption } from '../../../utils/providerModels';
import { useAgentVisibility } from '../../../hooks/useAgentVisibility';
import type { PendingPermissionRequest, PermissionMode } from '../types/types';
import {
  PERMISSION_MODE_CHANGED_EVENT,
  type PermissionModeChangedDetail,
} from '../../../constants/permissionModeEvents';
import {
  PROVIDER_DEFAULT_EFFORT_CHANGED_EVENT,
  type ProviderDefaultEffortChangedDetail,
} from '../../../constants/providerEffortEvents';
import type {
  ProjectSession,
  LLMProvider,
  Project,
  ProviderModelOption,
  ProviderModelsCacheInfo,
  ProviderModelsDefinition,
} from '../../../types/app';
import {
  DEFAULT_EFFORT_VALUE,
  FALLBACK_PROVIDER_EFFORT_VALUES,
  toProviderEffortOptions,
} from '../constants/providerEffort';

const FALLBACK_DEFAULT_MODEL: Record<LLMProvider, string> = {
  claude: 'default',
  cursor: 'gpt-5.3-codex',
  codex: 'gpt-5.4',
  opencode: 'anthropic/claude-sonnet-4-5',
  grok: 'grok-4.5',
  kimi: 'kimi-code/kimi-for-coding',
  pi: 'anthropic/claude-sonnet-4-20250514',
};

const PROVIDERS: LLMProvider[] = ['claude', 'cursor', 'codex', 'opencode', 'grok', 'kimi', 'pi'];
const CODEX_FAST_MODE_STORAGE_KEY = 'codex-fast-mode';

const readStoredProvider = (): LLMProvider => {
  const storedProvider = localStorage.getItem('selected-provider');
  return PROVIDERS.includes(storedProvider as LLMProvider)
    ? storedProvider as LLMProvider
    : 'claude';
};

/**
 * Per-session composer choices. Model and effort belong to a conversation,
 * not to the whole app: without these keys, switching between two chats shows
 * whichever value was picked last anywhere (the global `<provider>-model` /
 * `<provider>-effort` entries). Mirrors the per-session permissionMode keys.
 */
const getSessionModelStorageKey = (targetProvider: LLMProvider, sessionId: string): string =>
  `${targetProvider}-model-${sessionId}`;

const getSessionEffortStorageKey = (targetProvider: LLMProvider, sessionId: string): string =>
  `${targetProvider}-effort-${sessionId}`;

/**
 * Fallback permission-mode matrix used only until the backend capability
 * matrix (`GET /api/providers/capabilities`) has loaded. The backend is the
 * source of truth; this mirror exists so the composer renders sensibly on
 * first paint and when the capabilities request fails.
 */
const FALLBACK_PERMISSION_MODES: Record<LLMProvider, PermissionMode[]> = {
  claude: ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan'],
  // Cursor headless only supports default vs -f (bypass).
  cursor: ['default', 'bypassPermissions'],
  codex: ['default', 'auto', 'bypassPermissions'],
  opencode: ['default', 'acceptEdits', 'auto', 'plan'],
  grok: ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'plan'],
  kimi: ['default', 'plan', 'auto', 'bypassPermissions'],
  pi: ['plan', 'bypassPermissions'],
};

/**
 * Fallback image attachment support, used only until the backend capability
 * matrix loads. All current runtimes accept pasted/attached images (Claude as
 * base64 vision blocks; Grok/Cursor/OpenCode/Kimi as path references).
 * Mirrors provider-capabilities.service.ts.
 */
const FALLBACK_SUPPORTS_IMAGES: Record<LLMProvider, boolean> = {
  claude: true,
  cursor: true,
  codex: true,
  opencode: true,
  grok: true,
  kimi: true,
  pi: true,
};

/** Fallback document-attachment support: every agent reads path-referenced files. */
const FALLBACK_SUPPORTS_FILES: Record<LLMProvider, boolean> = {
  claude: true,
  cursor: true,
  codex: true,
  opencode: true,
  grok: true,
  kimi: true,
  pi: true,
};

type ProviderCapabilities = {
  provider: LLMProvider;
  permissionModes: string[];
  defaultPermissionMode: string;
  supportsImages: boolean;
  supportsFiles?: boolean;
  supportsAbort: boolean;
  supportsPermissionRequests: boolean;
  supportsTokenUsage: boolean;
  supportsEffort?: boolean;
};

type ProviderCapabilitiesApiResponse = {
  success?: boolean;
  data?: {
    providers?: ProviderCapabilities[];
  };
};

interface UseChatProviderStateArgs {
  selectedSession: ProjectSession | null;
  selectedProject: Project | null;
}

type ProviderModelsApiResponse = {
  success?: boolean;
  data?: {
    models?: ProviderModelsDefinition;
    cache?: ProviderModelsCacheInfo;
  };
};

type ChangeActiveModelApiResponse = {
  success?: boolean;
  data?: {
    provider?: LLMProvider;
    sessionId?: string;
    supported?: boolean;
    changed?: boolean;
    model?: string | null;
  };
};

export function useChatProviderState({ selectedSession, selectedProject: _selectedProject }: UseChatProviderStateArgs) {
  const { enabledProviders, isAgentEnabled } = useAgentVisibility();
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');
  const [pendingPermissionRequests, setPendingPermissionRequests] = useState<PendingPermissionRequest[]>([]);
  const [provider, setProvider] = useState<LLMProvider>(() => {
    const storedProvider = readStoredProvider();
    return isAgentEnabled(storedProvider) ? storedProvider : enabledProviders[0];
  });
  const [cursorModel, setCursorModel] = useState<string>(() => {
    return localStorage.getItem('cursor-model') || FALLBACK_DEFAULT_MODEL.cursor;
  });
  const [claudeModel, setClaudeModel] = useState<string>(() => {
    return localStorage.getItem('claude-model') || FALLBACK_DEFAULT_MODEL.claude;
  });
  const [codexModel, setCodexModel] = useState<string>(() => {
    return localStorage.getItem('codex-model') || FALLBACK_DEFAULT_MODEL.codex;
  });
  const [codexFastMode, setCodexFastMode] = useState<boolean>(() => (
    localStorage.getItem(CODEX_FAST_MODE_STORAGE_KEY) === 'true'
  ));
  const [providerEfforts, setProviderEfforts] = useState<Partial<Record<LLMProvider, string>>>(() => {
    return PROVIDERS.reduce<Partial<Record<LLMProvider, string>>>((acc, targetProvider) => {
      acc[targetProvider] = localStorage.getItem(`${targetProvider}-effort`) || DEFAULT_EFFORT_VALUE;
      return acc;
    }, {});
  });
  const [opencodeModel, setOpenCodeModel] = useState<string>(() => {
    return localStorage.getItem('opencode-model') || FALLBACK_DEFAULT_MODEL.opencode;
  });
  const [grokModel, setGrokModel] = useState<string>(() => {
    return localStorage.getItem('grok-model') || FALLBACK_DEFAULT_MODEL.grok;
  });
  const [kimiModel, setKimiModel] = useState<string>(() => {
    return localStorage.getItem('kimi-model') || FALLBACK_DEFAULT_MODEL.kimi;
  });
  const [piModel, setPiModel] = useState<string>(() => {
    return localStorage.getItem('pi-model') || FALLBACK_DEFAULT_MODEL.pi;
  });

  /**
   * Overrides for the currently open conversation, loaded from the
   * per-session storage keys above. Null means "nothing recorded for this
   * session" — the provider-level defaults apply. Without these, two chats on
   * the same provider always render the same (globally last-picked) model and
   * effort.
   */
  const [sessionModelOverride, setSessionModelOverride] = useState<string | null>(null);
  const [sessionEffortOverride, setSessionEffortOverride] = useState<string | null>(null);

  /**
   * Backend-owned capability matrix keyed by provider. Drives the permission
   * mode picker (and is the extension point for future per-provider UI
   * differences) so the frontend stays free of hardcoded provider branching.
   * Null until `/api/providers/capabilities` resolves; the static fallback
   * map covers that window.
   */
  const [providerCapabilities, setProviderCapabilities] = useState<
    Partial<Record<LLMProvider, ProviderCapabilities>> | null
  >(null);

  const [providerModelCatalog, setProviderModelCatalog] = useState<
    Partial<Record<LLMProvider, ProviderModelsDefinition>>
  >({});
  const [providerModelCacheCatalog, setProviderModelCacheCatalog] = useState<
    Partial<Record<LLMProvider, ProviderModelsCacheInfo>>
  >({});
  const [providerModelsLoading, setProviderModelsLoading] = useState(true);
  const [providerModelsRefreshing, setProviderModelsRefreshing] = useState(false);

  const providerModelsRequestIdRef = useRef(0);

  const setStoredProviderModel = useCallback((targetProvider: LLMProvider, model: string) => {
    if (targetProvider === 'claude') {
      setClaudeModel(model);
      localStorage.setItem('claude-model', model);
      return;
    }

    if (targetProvider === 'cursor') {
      setCursorModel(model);
      localStorage.setItem('cursor-model', model);
      return;
    }

    if (targetProvider === 'codex') {
      setCodexModel(model);
      localStorage.setItem('codex-model', model);
      return;
    }

    if (targetProvider === 'grok') {
      setGrokModel(model);
      localStorage.setItem('grok-model', model);
      return;
    }

    if (targetProvider === 'kimi') {
      setKimiModel(model);
      localStorage.setItem('kimi-model', model);
      return;
    }

    if (targetProvider === 'pi') {
      setPiModel(model);
      localStorage.setItem('pi-model', model);
      return;
    }

    setOpenCodeModel(model);
    localStorage.setItem('opencode-model', model);
  }, []);

  const setStoredProviderEffort = useCallback((targetProvider: LLMProvider, effort: string) => {
    setProviderEfforts((previous) => (
      previous[targetProvider] === effort
        ? previous
        : { ...previous, [targetProvider]: effort }
    ));
    localStorage.setItem(`${targetProvider}-effort`, effort);
  }, []);

  const selectCodexFastMode = useCallback((enabled: boolean) => {
    const nextEnabled = Boolean(enabled);
    setCodexFastMode(nextEnabled);
    localStorage.setItem(CODEX_FAST_MODE_STORAGE_KEY, String(nextEnabled));
  }, []);

  const loadProviderModels = useCallback(async (options: { bypassCache?: boolean } = {}) => {
    const requestId = providerModelsRequestIdRef.current + 1;
    providerModelsRequestIdRef.current = requestId;
    const isHardRefresh = options.bypassCache === true;

    if (isHardRefresh) {
      setProviderModelsRefreshing(true);
    } else {
      setProviderModelsLoading(true);
    }

    try {
      const results = await Promise.all(
        enabledProviders.map(async (p) => {
          const params = new URLSearchParams();
          if (options.bypassCache) {
            params.set('bypassCache', 'true');
          }

          const queryString = params.toString();
          try {
            const response = await authenticatedFetch(`/api/providers/${p}/models${queryString ? `?${queryString}` : ''}`);
            const body = (await response.json()) as ProviderModelsApiResponse;
            if (!body.success || !body.data?.models || !body.data?.cache) {
              return null;
            }

            return {
              provider: p,
              data: body.data,
            };
          } catch (error) {
            console.warn(`Unable to load ${p} models:`, error);
            return null;
          }
        }),
      );

      if (providerModelsRequestIdRef.current !== requestId) {
        return;
      }

      const nextCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>> = {};
      const nextCacheCatalog: Partial<Record<LLMProvider, ProviderModelsCacheInfo>> = {};

      results.forEach((entry) => {
        if (!entry) {
          return;
        }

        nextCatalog[entry.provider] = entry.data.models;
        nextCacheCatalog[entry.provider] = entry.data.cache;
      });

      setProviderModelCatalog((previous) => ({ ...previous, ...nextCatalog }));
      setProviderModelCacheCatalog((previous) => ({ ...previous, ...nextCacheCatalog }));
    } catch (error) {
      console.error('Error loading provider models:', error);
    } finally {
      if (providerModelsRequestIdRef.current === requestId) {
        setProviderModelsLoading(false);
        setProviderModelsRefreshing(false);
      }
    }
  }, [enabledProviders]);

  useEffect(() => {
    void loadProviderModels();
  }, [loadProviderModels]);

  useEffect(() => {
    let cancelled = false;

    const loadCapabilities = async () => {
      try {
        const response = await authenticatedFetch('/api/providers/capabilities');
        const body = (await response.json()) as ProviderCapabilitiesApiResponse;
        if (cancelled || !body.success || !Array.isArray(body.data?.providers)) {
          return;
        }

        const byProvider: Partial<Record<LLMProvider, ProviderCapabilities>> = {};
        for (const capabilities of body.data.providers) {
          byProvider[capabilities.provider] = capabilities;
        }
        setProviderCapabilities(byProvider);
      } catch (error) {
        console.error('Error loading provider capabilities:', error);
      }
    };

    void loadCapabilities();
    return () => {
      cancelled = true;
    };
  }, []);

  const getPermissionModesForProvider = useCallback((targetProvider: LLMProvider): PermissionMode[] => {
    const capabilityModes = providerCapabilities?.[targetProvider]?.permissionModes;
    if (capabilityModes && capabilityModes.length > 0) {
      return capabilityModes as PermissionMode[];
    }
    return FALLBACK_PERMISSION_MODES[targetProvider] ?? ['default'];
  }, [providerCapabilities]);

  const getDefaultPermissionModeForProvider = useCallback((targetProvider: LLMProvider): PermissionMode => {
    const modes = getPermissionModesForProvider(targetProvider);
    const capabilityDefault = providerCapabilities?.[targetProvider]?.defaultPermissionMode as PermissionMode | undefined;
    if (capabilityDefault && modes.includes(capabilityDefault)) {
      return capabilityDefault;
    }
    return modes[0] ?? 'default';
  }, [getPermissionModesForProvider, providerCapabilities]);

  const getSupportsEffortForProvider = useCallback((targetProvider: LLMProvider): boolean => {
    const capabilitySupport = providerCapabilities?.[targetProvider]?.supportsEffort;
    if (typeof capabilitySupport === 'boolean') {
      return capabilitySupport;
    }
    return Boolean(FALLBACK_PROVIDER_EFFORT_VALUES[targetProvider]?.length);
  }, [providerCapabilities]);

  const getSupportsImagesForProvider = useCallback((targetProvider: LLMProvider): boolean => {
    const capabilitySupport = providerCapabilities?.[targetProvider]?.supportsImages;
    if (typeof capabilitySupport === 'boolean') {
      return capabilitySupport;
    }
    return FALLBACK_SUPPORTS_IMAGES[targetProvider] ?? true;
  }, [providerCapabilities]);

  const getSupportsFilesForProvider = useCallback((targetProvider: LLMProvider): boolean => {
    const capabilitySupport = providerCapabilities?.[targetProvider]?.supportsFiles;
    if (typeof capabilitySupport === 'boolean') {
      return capabilitySupport;
    }
    return FALLBACK_SUPPORTS_FILES[targetProvider] ?? true;
  }, [providerCapabilities]);

  const pickStoredOrCurrent = (
    storageKey: string,
    current: string,
    def: ProviderModelsDefinition,
  ): string => {
    const stored = findProviderModelOption(def, localStorage.getItem(storageKey));
    if (stored) {
      return stored.value;
    }

    // `current` can arrive as a concrete model id from the session log, so it is
    // normalized back to the catalog alias the picker and storage use.
    return findProviderModelOption(def, current)?.value ?? def.DEFAULT;
  };

  const getModelOption = useCallback((
    targetProvider: LLMProvider,
    model: string,
  ): ProviderModelOption | null => {
    return findProviderModelOption(providerModelCatalog[targetProvider], model);
  }, [providerModelCatalog]);

  const getEffortOptionsForModel = useCallback((
    targetProvider: LLMProvider,
    model: string,
  ): NonNullable<ProviderModelOption['effort']>['values'] => {
    if (!getSupportsEffortForProvider(targetProvider)) {
      return [];
    }

    const option = getModelOption(targetProvider, model);
    if (option) {
      return option.effort?.values ?? [];
    }

    return toProviderEffortOptions(FALLBACK_PROVIDER_EFFORT_VALUES[targetProvider] ?? []);
  }, [getModelOption, getSupportsEffortForProvider]);

  const getAllowedEffortValues = useCallback((
    targetProvider: LLMProvider,
    model: string,
  ): string[] => (
    getEffortOptionsForModel(targetProvider, model).map((value) => value.value)
  ), [getEffortOptionsForModel]);

  const reconcileStoredEffort = useCallback((
    targetProvider: LLMProvider,
    model: string,
    currentEffort: string,
  ): string => {
    const allowedValues = getAllowedEffortValues(targetProvider, model);
    if (allowedValues.length === 0) {
      return DEFAULT_EFFORT_VALUE;
    }

    if (currentEffort === DEFAULT_EFFORT_VALUE || !currentEffort) {
      return DEFAULT_EFFORT_VALUE;
    }

    if (allowedValues.includes(currentEffort)) {
      return currentEffort;
    }

    return DEFAULT_EFFORT_VALUE;
  }, [getAllowedEffortValues]);

  const providerModels = useMemo<Record<LLMProvider, string>>(() => ({
    claude: claudeModel,
    cursor: cursorModel,
    codex: codexModel,
    opencode: opencodeModel,
    grok: grokModel,
    kimi: kimiModel,
    pi: piModel,
  }), [claudeModel, cursorModel, codexModel, opencodeModel, grokModel, kimiModel, piModel]);

  /** Effective model for the open conversation: its own recorded choice, or the provider default. */
  const currentProviderModel = useMemo(
    () => sessionModelOverride ?? providerModels[provider],
    [sessionModelOverride, providerModels, provider],
  );

  // Fast mode is advertised per Codex model in the live model catalog. Until
  // that catalog arrives, keep the control available for Codex's supported
  // fallback models; a model with an explicit false value disables it.
  const currentProviderSupportsFastMode = useMemo(() => {
    if (provider !== 'codex') {
      return false;
    }

    return getModelOption('codex', currentProviderModel)?.supportsFastMode ?? true;
  }, [currentProviderModel, getModelOption, provider]);

  useEffect(() => {
    const claude = providerModelCatalog.claude;
    if (claude) {
      const next = pickStoredOrCurrent('claude-model', claudeModel, claude);
      if (next !== claudeModel) {
        setClaudeModel(next);
      }
      if (localStorage.getItem('claude-model') !== next) {
        localStorage.setItem('claude-model', next);
      }
    }
  }, [providerModelCatalog.claude, claudeModel]);

  useEffect(() => {
    const cursor = providerModelCatalog.cursor;
    if (cursor) {
      const next = pickStoredOrCurrent('cursor-model', cursorModel, cursor);
      if (next !== cursorModel) {
        setCursorModel(next);
      }
      if (localStorage.getItem('cursor-model') !== next) {
        localStorage.setItem('cursor-model', next);
      }
    }
  }, [providerModelCatalog.cursor, cursorModel]);

  useEffect(() => {
    const codex = providerModelCatalog.codex;
    if (codex) {
      const next = pickStoredOrCurrent('codex-model', codexModel, codex);
      if (next !== codexModel) {
        setCodexModel(next);
      }
      if (localStorage.getItem('codex-model') !== next) {
        localStorage.setItem('codex-model', next);
      }
    }
  }, [providerModelCatalog.codex, codexModel]);

  useEffect(() => {
    const opencode = providerModelCatalog.opencode;
    if (opencode) {
      const next = pickStoredOrCurrent('opencode-model', opencodeModel, opencode);
      if (next !== opencodeModel) {
        setOpenCodeModel(next);
      }
      if (localStorage.getItem('opencode-model') !== next) {
        localStorage.setItem('opencode-model', next);
      }
    }
  }, [providerModelCatalog.opencode, opencodeModel]);

  useEffect(() => {
    const grok = providerModelCatalog.grok;
    if (grok) {
      const next = pickStoredOrCurrent('grok-model', grokModel, grok);
      if (next !== grokModel) {
        setGrokModel(next);
      }
      if (localStorage.getItem('grok-model') !== next) {
        localStorage.setItem('grok-model', next);
      }
    }
  }, [providerModelCatalog.grok, grokModel]);

  useEffect(() => {
    const kimi = providerModelCatalog.kimi;
    if (kimi) {
      const next = pickStoredOrCurrent('kimi-model', kimiModel, kimi);
      if (next !== kimiModel) {
        setKimiModel(next);
      }
      if (localStorage.getItem('kimi-model') !== next) {
        localStorage.setItem('kimi-model', next);
      }
    }
  }, [providerModelCatalog.kimi, kimiModel]);

  useEffect(() => {
    const pi = providerModelCatalog.pi;
    if (pi) {
      const next = pickStoredOrCurrent('pi-model', piModel, pi);
      if (next !== piModel) {
        setPiModel(next);
      }
      if (localStorage.getItem('pi-model') !== next) {
        localStorage.setItem('pi-model', next);
      }
    }
  }, [providerModelCatalog.pi, piModel]);

  useEffect(() => {
    const nextEfforts: Partial<Record<LLMProvider, string>> = {};
    let hasUpdates = false;

    for (const targetProvider of PROVIDERS) {
      const currentEffort = providerEfforts[targetProvider] ?? DEFAULT_EFFORT_VALUE;
      const nextEffort = reconcileStoredEffort(targetProvider, providerModels[targetProvider], currentEffort);
      if (nextEffort === currentEffort) {
        continue;
      }

      nextEfforts[targetProvider] = nextEffort;
      localStorage.setItem(`${targetProvider}-effort`, nextEffort);
      hasUpdates = true;
    }

    if (hasUpdates) {
      setProviderEfforts((previous) => ({ ...previous, ...nextEfforts }));
    }
  }, [providerEfforts, providerModels, reconcileStoredEffort]);

  useEffect(() => {
    const handleDefaultEffortChanged = (event: Event) => {
      const detail = (event as CustomEvent<ProviderDefaultEffortChangedDetail>).detail;
      if (!detail || !PROVIDERS.includes(detail.provider as LLMProvider) || typeof detail.effort !== 'string') {
        return;
      }

      const targetProvider = detail.provider as LLMProvider;
      setProviderEfforts((previous) => (
        previous[targetProvider] === detail.effort
          ? previous
          : { ...previous, [targetProvider]: detail.effort }
      ));
    };

    window.addEventListener(PROVIDER_DEFAULT_EFFORT_CHANGED_EVENT, handleDefaultEffortChanged);
    return () => window.removeEventListener(PROVIDER_DEFAULT_EFFORT_CHANGED_EVENT, handleDefaultEffortChanged);
  }, []);

  // Load the per-session model/effort overrides whenever the open
  // conversation (or its provider) changes. The stored model is normalized
  // against the live catalog once it arrives, so a renamed/removed model
  // falls back to the provider default instead of resurrecting a stale id.
  useEffect(() => {
    const sessionId = selectedSession?.id;
    if (!sessionId) {
      setSessionModelOverride(null);
      setSessionEffortOverride(null);
      return;
    }

    const storedModel = localStorage.getItem(getSessionModelStorageKey(provider, sessionId));
    const catalog = providerModelCatalog[provider];
    setSessionModelOverride(
      storedModel
        ? catalog
          ? findProviderModelOption(catalog, storedModel)?.value ?? null
          : storedModel
        : null,
    );
    setSessionEffortOverride(localStorage.getItem(getSessionEffortStorageKey(provider, sessionId)));
  }, [selectedSession?.id, provider, providerModelCatalog]);

  useEffect(() => {
    const validModes = getPermissionModesForProvider(provider);
    const sessionSavedMode = selectedSession?.id
      ? (localStorage.getItem(`permissionMode-${selectedSession.id}`) as PermissionMode | null)
      : null;
    // Fall back to the last mode picked for this provider: a brand-new chat
    // only receives its session id after the first send, so without this the
    // mode chosen beforehand would snap back to the default as soon as the
    // session id appears.
    const providerSavedMode = localStorage.getItem(`permissionMode-last-${provider}`) as PermissionMode | null;
    const savedMode = [sessionSavedMode, providerSavedMode].find(
      (mode): mode is PermissionMode => Boolean(mode && validModes.includes(mode)),
    );
    setPermissionMode(savedMode ?? getDefaultPermissionModeForProvider(provider));
  }, [selectedSession?.id, provider, getDefaultPermissionModeForProvider, getPermissionModesForProvider]);

  useEffect(() => {
    if (!selectedSession?.__provider || selectedSession.__provider === provider) {
      return;
    }

    // Never adopt a disabled provider from an old session - the guard below
    // would immediately flip it back, and the two effects would fight.
    if (!isAgentEnabled(selectedSession.__provider)) {
      return;
    }

    setProvider(selectedSession.__provider);
    localStorage.setItem('selected-provider', selectedSession.__provider);
  }, [provider, selectedSession, isAgentEnabled]);

  // When the active provider gets disabled in Settings, fall back to the
  // first enabled one so chat never sits on a hidden provider.
  useEffect(() => {
    if (isAgentEnabled(provider)) {
      return;
    }

    const fallbackProvider = enabledProviders[0];
    setProvider(fallbackProvider);
    localStorage.setItem('selected-provider', fallbackProvider);
  }, [provider, isAgentEnabled, enabledProviders]);

  // Permission prompts belong to a session, not to the transient provider
  // selection that is synchronized after navigation.
  useEffect(() => {
    setPendingPermissionRequests((previous) =>
      previous.filter((request) => !request.sessionId || request.sessionId === selectedSession?.id),
    );
  }, [selectedSession?.id]);

  useEffect(() => {
    if (provider !== 'cursor') {
      return;
    }

    authenticatedFetch('/api/cursor/config')
      .then((response) => response.json())
      .then((data) => {
        if (!data.success || !data.config?.model?.modelId) {
          return;
        }

        const modelId = data.config.model.modelId as string;
        if (!localStorage.getItem('cursor-model')) {
          setCursorModel(modelId);
        }
      })
      .catch((error) => {
        console.error('Error loading Cursor config:', error);
      });
  }, [provider]);

  const cyclePermissionMode = useCallback(() => {
    const modes = getPermissionModesForProvider(provider);

    const currentIndex = modes.indexOf(permissionMode);
    const nextIndex = (currentIndex + 1) % modes.length;
    const nextMode = modes[nextIndex];
    setPermissionMode(nextMode);

    // Persist per provider as well as per session: a brand-new chat has no
    // session id yet, and the per-provider key keeps the choice sticky when
    // the real id arrives (and for future sessions of this provider).
    localStorage.setItem(`permissionMode-last-${provider}`, nextMode);
    if (selectedSession?.id) {
      localStorage.setItem(`permissionMode-${selectedSession.id}`, nextMode);
    }

    // Let the Shell tab relaunch its interactive CLI with the new mode's
    // flags — TUI processes can't change mode after spawn.
    window.dispatchEvent(
      new CustomEvent<PermissionModeChangedDetail>(PERMISSION_MODE_CHANGED_EVENT, {
        detail: { provider, mode: nextMode, sessionId: selectedSession?.id ?? null },
      }),
    );
  }, [permissionMode, provider, selectedSession?.id, getPermissionModesForProvider]);

  const resolvePermissionModeForProvider = useCallback((
    targetProvider: LLMProvider,
    requestedMode: PermissionMode | string,
  ): PermissionMode => {
    const validModes = getPermissionModesForProvider(targetProvider);
    return validModes.includes(requestedMode as PermissionMode)
      ? requestedMode as PermissionMode
      : getDefaultPermissionModeForProvider(targetProvider);
  }, [getDefaultPermissionModeForProvider, getPermissionModesForProvider]);

  const selectProviderModel = useCallback(async (
    targetProvider: LLMProvider,
    model: string,
    sessionId?: string | null,
  ) => {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) {
      setStoredProviderModel(targetProvider, model);
      return {
        scope: 'default' as const,
        changed: false,
        model,
      };
    }

    const response = await authenticatedFetch(
      `/api/providers/${targetProvider}/sessions/${encodeURIComponent(normalizedSessionId)}/active-model`,
      {
        method: 'POST',
        body: JSON.stringify({ model }),
      },
    );

    const body = (await response.json()) as ChangeActiveModelApiResponse;
    if (!response.ok || !body.success || !body.data?.supported) {
      throw new Error('Unable to change the active model for this session.');
    }

    const appliedModel = body.data.model || model;
    // Record the choice against the session so navigating away and back shows
    // this chat's model instead of the last globally picked one.
    localStorage.setItem(getSessionModelStorageKey(targetProvider, normalizedSessionId), appliedModel);
    if (targetProvider === provider && selectedSession?.id === normalizedSessionId) {
      setSessionModelOverride(appliedModel);
    }

    return {
      scope: 'session' as const,
      changed: body.data.changed === true,
      model: appliedModel,
    };
  }, [provider, selectedSession?.id, setStoredProviderModel]);

  const selectProviderEffort = useCallback((
    targetProvider: LLMProvider,
    effort: string,
    sessionId?: string | null,
  ) => {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) {
      // No conversation yet: keep the provider-level default behavior.
      setStoredProviderEffort(targetProvider, effort);
      return;
    }

    localStorage.setItem(getSessionEffortStorageKey(targetProvider, normalizedSessionId), effort);
    if (targetProvider === provider && selectedSession?.id === normalizedSessionId) {
      setSessionEffortOverride(effort);
    }
  }, [provider, selectedSession?.id, setStoredProviderEffort]);

  /**
   * Snapshot the model/effort a message was actually sent with under the
   * session's keys. Called on every successful send so the very first message
   * of a chat — sent before the user ever touched the pickers — still pins
   * the session to the values it started with.
   */
  const persistSessionModelEffort = useCallback((
    targetProvider: LLMProvider,
    sessionId: string | null | undefined,
    model: string,
    effort: string,
  ) => {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) {
      return;
    }

    localStorage.setItem(getSessionModelStorageKey(targetProvider, normalizedSessionId), model);
    localStorage.setItem(getSessionEffortStorageKey(targetProvider, normalizedSessionId), effort);
    if (targetProvider === provider && selectedSession?.id === normalizedSessionId) {
      setSessionModelOverride(model);
      setSessionEffortOverride(effort);
    }
  }, [provider, selectedSession?.id]);

  const currentProviderEffortOptions = useMemo(() => {
    return getEffortOptionsForModel(provider, currentProviderModel);
  }, [getEffortOptionsForModel, provider, currentProviderModel]);
  const currentProviderEffort = useMemo(() => {
    return reconcileStoredEffort(
      provider,
      currentProviderModel,
      sessionEffortOverride ?? providerEfforts[provider] ?? DEFAULT_EFFORT_VALUE,
    );
  }, [provider, providerEfforts, sessionEffortOverride, currentProviderModel, reconcileStoredEffort]);

  return {
    provider,
    setProvider,
    cursorModel,
    setCursorModel,
    claudeModel,
    setClaudeModel,
    codexModel,
    setCodexModel,
    fastMode: provider === 'codex' && codexFastMode && currentProviderSupportsFastMode,
    supportsFastMode: provider === 'codex' && currentProviderSupportsFastMode,
    selectCodexFastMode,
    currentProviderEffort,
    currentProviderEffortOptions,
    opencodeModel,
    setOpenCodeModel,
    grokModel,
    setGrokModel,
    kimiModel,
    setKimiModel,
    piModel,
    setPiModel,
    permissionMode,
    setPermissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    cyclePermissionMode,
    providerModelCatalog,
    providerModelCacheCatalog,
    providerModelsLoading,
    providerModelsRefreshing,
    hardRefreshProviderModels: () => loadProviderModels({ bypassCache: true }),
    currentProviderModel,
    selectProviderModel,
    selectProviderEffort,
    persistSessionModelEffort,
    setStoredProviderEffort,
    resolvePermissionModeForProvider,
    // Attachment capabilities for the active provider: images need inline
    // vision (a subset of providers), documents are supported everywhere.
    supportsImages: getSupportsImagesForProvider(provider),
    supportsFiles: getSupportsFilesForProvider(provider),
  };
}
