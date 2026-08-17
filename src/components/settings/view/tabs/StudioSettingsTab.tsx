import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { Button } from '../../../../shared/view/ui';
import { authenticatedFetch } from '../../../../utils/api';
import type { LLMProvider, ProviderModelOption, ProviderModelsDefinition } from '../../../../types/app';
import { FALLBACK_PROVIDER_EFFORT_VALUES } from '../../../chat/constants/providerEffort';
import { studioApi, type StudioSeatProfile } from '../../../studio/api/studioApi';

const PROVIDERS: LLMProvider[] = ['claude', 'grok', 'codex', 'cursor', 'opencode', 'kilo', 'cline', 'kimi', 'qwencode', 'pi'];
const PERMISSIONS = ['bypassPermissions', 'acceptEdits', 'default'];

type ProviderModelsApiResponse = {
  data?: { models?: ProviderModelsDefinition };
  models?: ProviderModelsDefinition;
};

const modelOptionsFor = (
  provider: string,
  modelsByProvider: Partial<Record<LLMProvider, ProviderModelsDefinition>>,
): ProviderModelOption[] => modelsByProvider[provider as LLMProvider]?.OPTIONS ?? [];

const effortOptionsFor = (
  seat: StudioSeatProfile,
  modelsByProvider: Partial<Record<LLMProvider, ProviderModelsDefinition>>,
): string[] => {
  const selectedModel = modelOptionsFor(seat.provider, modelsByProvider)
    .find((model) => model.value === seat.model);
  const modelEfforts = selectedModel?.effort?.values.map((option) => option.value) ?? [];
  return modelEfforts.length > 0
    ? modelEfforts
    : [...(FALLBACK_PROVIDER_EFFORT_VALUES[seat.provider as LLMProvider] ?? ['low', 'medium', 'high'])];
};

export default function StudioSettingsTab() {
  const [seats, setSeats] = useState<StudioSeatProfile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [modelsByProvider, setModelsByProvider] = useState<
    Partial<Record<LLMProvider, ProviderModelsDefinition>>
  >({});
  const [modelsLoading, setModelsLoading] = useState<Set<LLMProvider>>(new Set());

  const providersInSeats = useMemo(
    () => [...new Set(seats.map((seat) => seat.provider as LLMProvider))],
    [seats],
  );

  useEffect(() => {
    const providers = providersInSeats.filter((provider) => !modelsByProvider[provider]);
    if (providers.length === 0) return undefined;

    let cancelled = false;
    setModelsLoading((current) => new Set([...current, ...providers]));
    void Promise.all(providers.map(async (provider): Promise<[
      LLMProvider,
      ProviderModelsDefinition
    ]> => {
      let definition: ProviderModelsDefinition | null = null;
      try {
        const response = await authenticatedFetch(`/api/providers/${provider}/models`);
        if (response.ok) {
          const body = (await response.json()) as ProviderModelsApiResponse;
          definition = body.data?.models ?? body.models ?? null;
        }
      } catch {
        // The provider may be unavailable; the fallback effort options remain usable.
      }
      return [provider, definition ?? { OPTIONS: [], DEFAULT: '' }];
    })).then((entries) => {
      if (!cancelled) {
        setModelsByProvider((current) => ({ ...current, ...Object.fromEntries(entries) }));
        setModelsLoading((current) => {
          const next = new Set(current);
          providers.forEach((provider) => next.delete(provider));
          return next;
        });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [modelsByProvider, providersInSeats]);

  useEffect(() => {
    void studioApi.getSettings()
      .then(setSeats)
      .catch((err: Error) => setError(err.message));
  }, []);

  const updateSeat = (id: string, patch: Partial<StudioSeatProfile>) => {
    setSeats((current) => current.map((seat) => (seat.id === id ? { ...seat, ...patch } : seat)));
    setSaved(false);
  };

  const handleSave = async () => {
    setBusy(true);
    setError(null);
    try {
      setSeats(await studioApi.saveSettings(seats));
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save Studio seats');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Studio design swarm</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick who builds each Studio prototype. The builder must be allowed to write files or the swarm will stall.
        </p>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div className="space-y-4">
        {seats.map((seat) => (
          <div key={seat.id} className="rounded-xl border border-border bg-card p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">{seat.label}</div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground">{seat.kind}</div>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={seat.enabled}
                  disabled={seat.id === 'architect' || seat.id === 'builder'}
                  onChange={(event) => updateSeat(seat.id, { enabled: event.target.checked })}
                />
                Enabled
              </label>
            </div>
            <div className="mt-3 grid gap-3 md:grid-cols-3">
              <label className="text-xs text-muted-foreground">
                Provider
                <select
                  className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground"
                  value={seat.provider}
                  onChange={(event) => {
                    const provider = event.target.value as LLMProvider;
                    const definition = modelsByProvider[provider];
                    const model = definition?.DEFAULT ?? definition?.OPTIONS[0]?.value ?? null;
                    updateSeat(seat.id, { provider, model });
                  }}
                >
                  {PROVIDERS.map((provider) => (
                    <option key={provider} value={provider}>{provider}</option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-muted-foreground">
                Effort
                <select
                  className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground"
                  value={seat.effort}
                  onChange={(event) => updateSeat(seat.id, { effort: event.target.value })}
                >
                  {effortOptionsFor(seat, modelsByProvider).map((effort) => (
                    <option key={effort} value={effort}>{effort}</option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-muted-foreground">
                Permissions
                <select
                  className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground"
                  value={seat.permissionMode}
                  onChange={(event) => updateSeat(seat.id, { permissionMode: event.target.value })}
                >
                  {PERMISSIONS.map((mode) => (
                    <option key={mode} value={mode}>{mode}</option>
                  ))}
                </select>
              </label>
            </div>
            <label className="mt-3 block text-xs text-muted-foreground">
              Model
              <select
                className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground"
                value={seat.model ?? ''}
                disabled={modelsLoading.has(seat.provider as LLMProvider)}
                onChange={(event) => {
                  const model = event.target.value || null;
                  const nextEfforts = effortOptionsFor({ ...seat, model }, modelsByProvider);
                  updateSeat(seat.id, {
                    model,
                    effort: nextEfforts.includes(seat.effort) ? seat.effort : (nextEfforts[0] ?? seat.effort),
                  });
                }}
              >
                <option value="">Provider default</option>
                {seat.model && !modelOptionsFor(seat.provider, modelsByProvider).some((option) => option.value === seat.model) ? (
                  <option value={seat.model}>{seat.model} (saved)</option>
                ) : null}
                {modelOptionsFor(seat.provider, modelsByProvider).map((model) => (
                  <option key={model.value} value={model.value}>{model.label}</option>
                ))}
              </select>
            </label>
            <label className="mt-3 block text-xs text-muted-foreground">
              Focus
              <textarea
                className="mt-1 min-h-16 w-full rounded-md border border-border bg-background px-2 py-2 text-sm text-foreground"
                value={seat.focus}
                onChange={(event) => updateSeat(seat.id, { focus: event.target.value })}
              />
            </label>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <Button onClick={() => void handleSave()} disabled={busy}>
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Save Studio seats
        </Button>
        {saved ? <span className="text-sm text-muted-foreground">Saved</span> : null}
      </div>
    </div>
  );
}
