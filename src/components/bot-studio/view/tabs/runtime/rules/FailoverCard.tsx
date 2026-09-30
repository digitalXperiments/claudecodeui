import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Loader2, Plus, X } from 'lucide-react';

import { MC_PROVIDERS } from '../../../../../mission-control/api/missionControlApi';
import { botRuntimeApi } from '../../../../api/botRuntimeApi';
import type { BotPhaseRoute } from '../../../../types/botRuntime';
import AgentModelEffortFields from '../../AgentModelEffortFields';
import { EmptyLine, ErrorLine, Panel, SkeletonRows } from '../panel/Panel';
import { useAsyncAction } from '../panel/useAsyncAction';
import { useRemote } from '../panel/useRemote';

import { MAX_FALLBACK_ROUTES, cleanRoutes, moveRoute, routeLabel, routesEqual, validateRoutes } from './ruleHelpers';

/** The provider failover chain: tried in order when the bot's own provider errors or is rate limited. */
export default function FailoverCard({ botId, primary }: { botId: string; primary: string }) {
  const { data, error, loading, setData } = useRemote(() => botRuntimeApi.exec.getFallback(botId), botId);
  const action = useAsyncAction();
  const [routes, setRoutes] = useState<BotPhaseRoute[]>([]);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (data) setRoutes(data); }, [data]);

  const dirty = data !== null && !routesEqual(routes, data);
  const problem = validateRoutes(routes);
  const edit = (next: BotPhaseRoute[]) => { setSaved(false); setRoutes(next); };
  const firstFree = MC_PROVIDERS.find((provider) => provider !== primary && !routes.some((route) => route.provider === provider)) ?? MC_PROVIDERS[0];

  const save = async () => {
    if (problem) return;
    const ok = await action.run('save', async () => {
      const next = await botRuntimeApi.exec.setFallback(botId, cleanRoutes(routes));
      setData(next);
      setRoutes(next);
    });
    setSaved(ok);
  };

  return (
    <Panel title="Failover chain" description="When this bot's provider errors or hits a limit, the next one here takes over so the wake-up still finishes.">
      <div className="space-y-2">
        {loading && !data ? <SkeletonRows count={1} /> : null}
        <ErrorLine message={error} />
        {data ? (
          <>
            <p className="text-xs"><span className="text-muted-foreground">Primary:</span> <span className="font-medium">{primary}</span></p>
            {routes.length === 0 ? <EmptyLine>No fallback providers. A failure on the primary ends the wake-up.</EmptyLine> : null}
            <ol className="space-y-2">
              {routes.map((route, index) => (
                <li key={index} className="flex items-start gap-2 rounded-lg border border-border/60 bg-background p-2.5">
                  <span className="mt-6 w-5 shrink-0 text-center text-[11px] font-semibold text-muted-foreground">{index + 1}</span>
                  <div className="min-w-0 flex-1">
                    <AgentModelEffortFields label={`Fallback ${index + 1}`} value={{ provider: route.provider, model: route.model ?? null, effort: route.effort ?? null }} onChange={(next) => edit(routes.map((entry, i) => (i === index ? { provider: next.provider ?? entry.provider, ...(next.model ? { model: next.model } : {}), ...(next.effort ? { effort: next.effort } : {}) } : entry)))} />
                  </div>
                  <div className="mt-5 flex shrink-0 gap-0.5">
                    <button type="button" className="icon-button" aria-label={`Move fallback ${index + 1} up`} disabled={index === 0} onClick={() => edit(moveRoute(routes, index, -1))}><ArrowUp className="h-4 w-4" /></button>
                    <button type="button" className="icon-button" aria-label={`Move fallback ${index + 1} down`} disabled={index === routes.length - 1} onClick={() => edit(moveRoute(routes, index, 1))}><ArrowDown className="h-4 w-4" /></button>
                    <button type="button" className="icon-button" aria-label={`Remove fallback ${index + 1}`} onClick={() => edit(routes.filter((_, i) => i !== index))}><X className="h-4 w-4" /></button>
                  </div>
                </li>
              ))}
            </ol>
            {routes.length > 0 ? <p className="text-[11px] text-muted-foreground">Order: {[primary, ...routes.map(routeLabel)].join(' → ')}</p> : null}
            <ErrorLine message={problem ?? action.error} />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button type="button" className="button min-h-8" disabled={routes.length >= MAX_FALLBACK_ROUTES} onClick={() => edit([...routes, { provider: firstFree }])}><Plus className="h-3.5 w-3.5" aria-hidden="true" />Add fallback</button>
              <div className="flex items-center gap-2">
                {saved && !dirty ? <span className="text-[11px] text-emerald-700 dark:text-emerald-300" role="status">Saved</span> : null}
                <button type="button" className="button button-primary" disabled={!dirty || Boolean(problem) || action.busy} onClick={() => void save()}>{action.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}Save chain</button>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </Panel>
  );
}
