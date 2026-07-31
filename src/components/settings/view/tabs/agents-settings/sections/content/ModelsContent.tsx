import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { authenticatedFetch } from '../../../../../../../utils/api';
import { AGENT_NAMES } from '../../../../../constants/constants';
import type { AgentProvider } from '../../../../../types/types';
import type { ProviderModelsDefinition } from '../../../../../../../types/app';

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

export default function ModelsContent({ agent }: ModelsContentProps) {
  const { t } = useTranslation('settings');
  const [models, setModels] = useState<ProviderModelsDefinition | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [defaultModel, setDefaultModel] = useState<string>(() => localStorage.getItem(storageKey(agent)) || '');

  useEffect(() => {
    setDefaultModel(localStorage.getItem(storageKey(agent)) || '');
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
          if (current) return current;
          return body.data?.models?.DEFAULT ?? '';
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

  const handleChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value;
    setDefaultModel(value);
    localStorage.setItem(storageKey(agent), value);
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
            defaultValue: `Choose the model ${AGENT_NAMES[agent]} loads by default when you open chat.`,
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
              onChange={handleChange}
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
      </div>
    </div>
  );
}
