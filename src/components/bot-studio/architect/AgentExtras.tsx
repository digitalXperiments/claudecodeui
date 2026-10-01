import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';

import { MC_PROVIDERS } from '../../mission-control/api/missionControlApi';
import type { BotPhaseRoute } from '../types/botRuntime';
import AgentModelEffortFields from '../view/tabs/AgentModelEffortFields';
import { MAX_FALLBACK_ROUTES, moveRoute, routeLabel, validateRoutes } from '../view/tabs/runtime/rules/ruleHelpers';

import EnforcementNotice, { type EnforcementState } from './EnforcementNotice';
import { FieldLabel, SwitchRow } from './parts';
import type { RuntimeDraft } from './runtimeDraft';

/** Runtime v2 additions to the Agent step: enforcement, backup providers and a cheaper triage model. */
export default function AgentExtras({ provider, runtime, onChange, enforcement }: { provider: string; runtime: RuntimeDraft; onChange: (patch: Partial<RuntimeDraft>) => void; enforcement: EnforcementState }) {
  const { fallback, watcher } = runtime;
  const problem = validateRoutes(fallback);
  const firstFree = MC_PROVIDERS.find((candidate) => candidate !== provider && !fallback.some((route) => route.provider === candidate)) ?? MC_PROVIDERS[0];
  const setFallback = (next: BotPhaseRoute[]) => onChange({ fallback: next });

  return (
    <div className="space-y-5">
      <EnforcementNotice provider={provider} state={enforcement} />

      <div className="space-y-2">
        <FieldLabel detail="optional">If {provider} is down or rate-limited</FieldLabel>
        <p className="text-[11px] leading-relaxed text-muted-foreground">Backup providers take over in order, so the wake-up still finishes. They are used only for errors and usage limits, never because a task went badly.</p>
        {fallback.length === 0 ? <p className="rounded-lg border border-dashed border-border/70 px-3 py-3 text-center text-xs text-muted-foreground">No backups. If {provider} fails, that wake-up ends.</p> : null}
        <ol className="space-y-2">
          {fallback.map((route, index) => (
            <li key={index} className="flex items-start gap-2 rounded-lg border border-border/60 bg-background p-2.5">
              <span className="mt-6 w-5 shrink-0 text-center text-[11px] font-semibold text-muted-foreground">{index + 1}</span>
              <div className="min-w-0 flex-1">
                <AgentModelEffortFields label={`Backup ${index + 1}`} value={{ provider: route.provider, model: route.model ?? null, effort: route.effort ?? null }} onChange={(next) => setFallback(fallback.map((entry, i) => (i === index ? { provider: next.provider ?? entry.provider, ...(next.model ? { model: next.model } : {}), ...(next.effort ? { effort: next.effort } : {}) } : entry)))} />
              </div>
              <div className="mt-5 flex shrink-0 gap-0.5">
                <button type="button" className="icon-button" aria-label={`Move backup ${index + 1} up`} disabled={index === 0} onClick={() => setFallback(moveRoute(fallback, index, -1))}><ArrowUp className="h-4 w-4" /></button>
                <button type="button" className="icon-button" aria-label={`Move backup ${index + 1} down`} disabled={index === fallback.length - 1} onClick={() => setFallback(moveRoute(fallback, index, 1))}><ArrowDown className="h-4 w-4" /></button>
                <button type="button" className="icon-button" aria-label={`Remove backup ${index + 1}`} onClick={() => setFallback(fallback.filter((_, i) => i !== index))}><X className="h-4 w-4" /></button>
              </div>
            </li>
          ))}
        </ol>
        {fallback.length > 0 ? <p className="text-[11px] text-muted-foreground">Order: {[provider, ...fallback.map(routeLabel)].join(' → ')}</p> : null}
        {problem ? <p role="alert" className="text-xs text-red-600 dark:text-red-300">{problem}</p> : null}
        <button type="button" className="button min-h-8" disabled={fallback.length >= MAX_FALLBACK_ROUTES} onClick={() => setFallback([...fallback, { provider: firstFree }])}><Plus className="h-3.5 w-3.5" aria-hidden="true" />Add a backup provider</button>
      </div>

      <div className="space-y-2">
        <SwitchRow
          title="Use a cheaper model to screen signals first"
          description="A lighter model reads what arrives (webhooks, watched feeds, board events) and only wakes the main model when something looks relevant. If screening fails, everything goes through."
          checked={watcher.enabled}
          onChange={(enabled) => onChange({ watcher: { enabled, route: enabled && !watcher.route.provider ? { provider, model: null, effort: null } : watcher.route } })}
        />
        {watcher.enabled ? (
          <div className="rounded-xl border border-border/60 bg-background p-3">
            <AgentModelEffortFields label="Screening model" value={watcher.route} onChange={(route) => onChange({ watcher: { enabled: true, route } })} />
            <p className="mt-2 text-[11px] text-muted-foreground">Pick a smaller, cheaper model than the one you chose above. It never takes actions; it only decides whether to wake the bot.</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
