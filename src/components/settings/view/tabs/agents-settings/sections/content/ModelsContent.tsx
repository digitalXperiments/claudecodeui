import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { authenticatedFetch } from '../../../../../../../utils/api';
import { readHiddenModels, writeHiddenModels } from '../../../../../../../utils/modelVisibility';
import { DEFAULT_EFFORT_VALUE } from '../../../../../../chat/constants/providerEffort';
import { AGENT_NAMES } from '../../../../../constants/constants';
import {
  PROVIDER_DEFAULT_EFFORT_CHANGED_EVENT,
  type ProviderDefaultEffortChangedDetail,
} from '../../../../../../../constants/providerEffortEvents';
import type { AgentProvider } from '../../../../../types/types';
import type { ProviderModelOption, ProviderModelsDefinition } from '../../../../../../../types/app';

type ModelsContentProps = {
  agent: AgentProvider;
};

type ProviderModelsApiResponse = {
  success?: boolean;
  data?: {
    models?: ProviderModelsDefinition;
  };
};

const storageKey = (agent: AgentProvider) => `${agent}-model`;
const effortStorageKey = (agent: AgentProvider) => `${agent}-effort`;

const writeDefaultEffort = (agent: AgentProvider, effort: string) => {
  localStorage.setItem(effortStorageKey(agent), effort);
  window.dispatchEvent(
    new CustomEvent<ProviderDefaultEffortChangedDetail>(PROVIDER_DEFAULT_EFFORT_CHANGED_EVENT, {
      detail: { provider: agent, effort },
    }),
  );
};

const getEffortOptions = (model: ProviderModelOption | undefined) => model?.effort?.values ?? [];

const normalizeEffort = (model: ProviderModelOption | undefined, effort: string | null | undefined): string => {
  const values = getEffortOptions(model).map((option) => option.value);
  if (values.length === 0) {
    return DEFAULT_EFFORT_VALUE;
  }
  if (effort === DEFAULT_EFFORT_VALUE || (effort && values.includes(effort))) {
    return effort;
  }
  return DEFAULT_EFFORT_VALUE;
};

export default function ModelsContent({ agent }: ModelsContentProps) {
  const { t } = useTranslation('settings');
  const [models, setModels] = useState<ProviderModelsDefinition | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [defaultModel, setDefaultModel] = useState<string>(() => localStorage.getItem(storageKey(agent)) || '');
  const [defaultEffort, setDefaultEffort] = useState<string>(
    () => localStorage.getItem(effortStorageKey(agent)) || DEFAULT_EFFORT_VALUE,
  );
  const [hiddenModels, setHiddenModels] = useState<string[]>(() => readHiddenModels(agent));
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    setDefaultModel(localStorage.getItem(storageKey(agent)) || '');
    setDefaultEffort(localStorage.getItem(effortStorageKey(agent)) || DEFAULT_EFFORT_VALUE);
    setHiddenModels(readHiddenModels(agent));
  }, [agent]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const response = await authenticatedFetch(`/api/providers/${agent}/models`);
        const body = (await response.json()) as ProviderModelsApiResponse;
        if (cancelled) return;
        if (!body.success || !body.data?.models) {
          setError(t('agents.models.loadError', { defaultValue: 'Could not load models for this agent.' }));
          setModels(null);
          return;
        }
        setModels(body.data.models);
        setDefaultModel((current) => {
          const options = body.data?.models?.OPTIONS ?? [];
          if (options.some((option) => option.value === current)) return current;
          const stored = localStorage.getItem(storageKey(agent));
          if (options.some((option) => option.value === stored)) return stored as string;
          return options.find((option) => option.value === body.data?.models?.DEFAULT)?.value
            ?? options[0]?.value
            ?? '';
        });
      } catch {
        if (!cancelled) {
          setError(t('agents.models.loadError', { defaultValue: 'Could not load models for this agent.' }));
          setModels(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [agent, t]);

  const defaultModelOption = useMemo(
    () => models?.OPTIONS.find((option) => option.value === defaultModel),
    [defaultModel, models],
  );
  const effortOptions = useMemo(
    () => getEffortOptions(defaultModelOption).filter((option) => option.value !== DEFAULT_EFFORT_VALUE),
    [defaultModelOption],
  );

  // Effort support is model-specific for some providers. Keep a previously
  // saved value when the new default model supports it, otherwise fall back to
  // the provider/model default rather than sending an invalid effort.
  useEffect(() => {
    if (loading || !defaultModelOption) return;
    const nextEffort = normalizeEffort(
      defaultModelOption,
      localStorage.getItem(effortStorageKey(agent)) || defaultEffort,
    );
    if (nextEffort !== defaultEffort) {
      setDefaultEffort(nextEffort);
    }
    if (localStorage.getItem(effortStorageKey(agent)) !== nextEffort) {
      writeDefaultEffort(agent, nextEffort);
    }
  }, [agent, defaultEffort, defaultModelOption, loading]);

  const handleModelChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value;
    setDefaultModel(value);
    localStorage.setItem(storageKey(agent), value);

    const selectedModel = models?.OPTIONS.find((option) => option.value === value);
    const nextEffort = normalizeEffort(
      selectedModel,
      localStorage.getItem(effortStorageKey(agent)) || defaultEffort,
    );
    setDefaultEffort(nextEffort);
    writeDefaultEffort(agent, nextEffort);
  };

  const handleEffortChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const value = normalizeEffort(defaultModelOption, event.target.value);
    setDefaultEffort(value);
    writeDefaultEffort(agent, value);
  };

  const options = useMemo(() => models?.OPTIONS ?? [], [models]);

  const filteredOptions = useMemo(() => {
    const normalized = searchQuery.trim().toLowerCase();
    if (!normalized) {
      return options;
    }
    return options.filter((option) =>
      `${option.label} ${option.value} ${option.description || ''}`.toLowerCase().includes(normalized),
    );
  }, [options, searchQuery]);

  const toggleModelVisibility = (value: string) => {
    setHiddenModels((previous) => {
      const next = previous.includes(value)
        ? previous.filter((entry) => entry !== value)
        : [...previous, value];
      writeHiddenModels(agent, next);
      return next;
    });
  };

  const setAllVisible = (visible: boolean) => {
    // The default model is always shown, so "hide all" keeps it visible.
    const next = visible
      ? []
      : options.map((option) => option.value).filter((value) => value !== defaultModel);
    setHiddenModels(next);
    writeHiddenModels(agent, next);
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-foreground">
          {t('agents.models.title', { defaultValue: 'Models' })}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t('agents.models.description', {
            agent: AGENT_NAMES[agent],
            defaultValue: `Choose the model ${AGENT_NAMES[agent]} loads by default when you open chat. Models that support it also offer a default reasoning effort.`,
          })}
        </p>
      </div>

      <div className="rounded-lg border border-border p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-foreground">
              {t('agents.models.defaultLabel', { defaultValue: 'Default model' })}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {t('agents.models.defaultDescription', { defaultValue: 'Used the next time chat loads for this agent.' })}
            </div>
          </div>

          {loading ? (
            <span className="text-xs text-muted-foreground">{t('agents.models.loading', { defaultValue: 'Loading…' })}</span>
          ) : error ? (
            <span className="text-xs text-red-600 dark:text-red-400">{error}</span>
          ) : (
            <select
              value={defaultModel}
              onChange={handleModelChange}
              className="w-56 rounded-lg border border-input bg-card p-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            >
              {(models?.OPTIONS ?? []).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
        </div>

        {!loading && !error && models?.OPTIONS.find((option) => option.value === defaultModel)?.description && (
          <p className="mt-3 border-t border-border/50 pt-3 text-xs text-muted-foreground">
            {models.OPTIONS.find((option) => option.value === defaultModel)?.description}
          </p>
        )}

        {!loading && !error && effortOptions.length > 0 && (
          <div className="mt-4 border-t border-border/50 pt-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-foreground">
                  {t('agents.models.defaultEffortLabel', { defaultValue: 'Default effort' })}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {t('agents.models.defaultEffortDescription', {
                    defaultValue: 'Used for new chats with the selected model. Choose Default to let the provider decide.',
                  })}
                </div>
              </div>

              <select
                value={defaultEffort}
                onChange={handleEffortChange}
                className="w-56 rounded-lg border border-input bg-card p-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value={DEFAULT_EFFORT_VALUE}>
                  {t('agents.models.defaultEffortOption', { defaultValue: 'Default' })}
                </option>
                {effortOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.value}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
      </div>

      <div className="rounded-lg border border-border p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-foreground">
              {t('agents.models.visibleLabel', { defaultValue: 'Models shown on new session' })}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {t('agents.models.visibleDescription', {
                agent: AGENT_NAMES[agent],
                defaultValue: `Pick which ${AGENT_NAMES[agent]} models appear in the picker when you start a new chat. The default model is always shown; hidden models stay reachable from the mid-session switcher.`,
              })}
            </div>
          </div>

          {!loading && !error && options.length > 0 && (
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={() => setAllVisible(true)}
                className="rounded-lg border border-input px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {t('agents.models.showAll', { defaultValue: 'Show all' })}
              </button>
              <button
                type="button"
                onClick={() => setAllVisible(false)}
                className="rounded-lg border border-input px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {t('agents.models.hideAll', { defaultValue: 'Hide all' })}
              </button>
            </div>
          )}
        </div>

        {loading ? (
          <span className="mt-3 block text-xs text-muted-foreground">
            {t('agents.models.loading', { defaultValue: 'Loading…' })}
          </span>
        ) : error ? (
          <span className="mt-3 block text-xs text-red-600 dark:text-red-400">{error}</span>
        ) : options.length === 0 ? (
          <span className="mt-3 block text-xs text-muted-foreground">
            {t('agents.models.noModels', { defaultValue: 'No models available for this agent.' })}
          </span>
        ) : (
          <>
            <input
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={t('agents.models.searchPlaceholder', { defaultValue: 'Search models…' })}
              className="mt-3 w-full rounded-lg border border-input bg-card p-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />

            <div className="scrollbar-thin mt-2 max-h-64 space-y-1 overflow-y-auto rounded-lg border border-border/60 p-2">
              {filteredOptions.length > 0 ? (
                filteredOptions.map((option) => {
                  const isDefault = option.value === defaultModel;
                  const hidden = hiddenModels.includes(option.value);
                  return (
                    <label
                      key={option.value}
                      className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors ${
                        isDefault ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-muted'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={!hidden}
                        disabled={isDefault}
                        onChange={() => toggleModelVisibility(option.value)}
                        className="h-4 w-4 shrink-0 accent-primary"
                      />
                      <span className="min-w-0 flex-1 truncate text-foreground">{option.label}</span>
                      {isDefault ? (
                        <span className="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                          {t('agents.models.defaultBadge', { defaultValue: 'Default' })}
                        </span>
                      ) : hidden ? (
                        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                          {t('agents.models.hiddenBadge', { defaultValue: 'Hidden' })}
                        </span>
                      ) : null}
                    </label>
                  );
                })
              ) : (
                <p className="px-2 py-3 text-xs text-muted-foreground">
                  {t('agents.models.noMatches', { defaultValue: 'No models match that search.' })}
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
