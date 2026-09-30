import { MC_PROVIDERS } from '../../../mission-control/api/missionControlApi';

import { useProviderModels } from './useProviderModels';

export type AgentChoice = { provider: string | null; model: string | null; effort: string | null };

/**
 * Agent · Model · Effort selects. Effort only offers the selected model's
 * catalog levels (runtimes silently ignore unsupported ones). With
 * `sameOption`, the agent select starts with a "same as …" choice (provider null)
 * that hides Model and Effort.
 */
export default function AgentModelEffortFields({ value, onChange, sameOption, disabled = false, label = 'Agent' }: {
  value: AgentChoice;
  onChange: (next: AgentChoice) => void;
  sameOption?: string;
  disabled?: boolean;
  label?: string;
}) {
  const { models, loading } = useProviderModels(value.provider ?? '', Boolean(value.provider) && !disabled);
  const efforts = models.find((model) => model.value === value.model)?.effort?.values ?? [];
  const providers = value.provider && !(MC_PROVIDERS as readonly string[]).includes(value.provider) ? [value.provider, ...MC_PROVIDERS] : [...MC_PROVIDERS];
  return <div className={`grid gap-2 sm:grid-cols-3 ${disabled ? 'opacity-60' : ''}`}>
    <label className="block min-w-0 text-[11px] text-muted-foreground">{label}
      <select aria-label={label} disabled={disabled} className="field mt-1 h-9 w-full" value={value.provider ?? ''} onChange={(event) => onChange({ provider: event.target.value || null, model: null, effort: null })}>
        {sameOption ? <option value="">{sameOption}</option> : null}
        {providers.map((provider) => <option key={provider} value={provider}>{provider}</option>)}
      </select>
    </label>
    {value.provider ? <>
      <label className="block min-w-0 text-[11px] text-muted-foreground">Model
        <select aria-label={`${label} model`} disabled={disabled || loading} className="field mt-1 h-9 w-full" value={value.model ?? ''} onChange={(event) => {
          const levels = models.find((model) => model.value === event.target.value)?.effort?.values ?? [];
          onChange({ ...value, model: event.target.value || null, effort: levels.some((level) => level.value === value.effort) ? value.effort : null });
        }}>
          <option value="">{loading ? 'Loading models…' : 'Provider default'}</option>
          {value.model && !models.some((model) => model.value === value.model) ? <option value={value.model}>{value.model}{loading ? '' : ' (unavailable)'}</option> : null}
          {models.map((model) => <option key={model.value} value={model.value}>{model.label}</option>)}
        </select>
      </label>
      <label className="block min-w-0 text-[11px] text-muted-foreground">Effort
        <select aria-label={`${label} effort`} disabled={disabled || loading || (!efforts.length && !value.effort)} className="field mt-1 h-9 w-full" value={value.effort ?? ''} onChange={(event) => onChange({ ...value, effort: event.target.value || null })}>
          <option value="">{efforts.length ? 'Model default' : 'Set by model'}</option>
          {value.effort && !efforts.some((level) => level.value === value.effort) ? <option value={value.effort}>{value.effort}{loading ? '' : ' (unsupported)'}</option> : null}
          {efforts.map((level) => <option key={level.value} value={level.value}>{level.value}</option>)}
        </select>
      </label>
    </> : null}
  </div>;
}
