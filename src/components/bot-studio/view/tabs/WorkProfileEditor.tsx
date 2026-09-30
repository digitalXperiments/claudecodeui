import { Button } from '../../../../shared/view/ui';
import { useMcpCatalog } from '../../../mcp/hooks/useMcpCatalog';
import { MC_PROVIDERS, type McProvider, type McWorkProfile } from '../../../mission-control/api/missionControlApi';

import { useProviderModels } from './useProviderModels';
import { workMcpUnavailableReason } from './workMcpAvailability';

/**
 * Work-session settings (agent, model, effort, MCP, default project, client
 * mappings). Controlled: the Work stage card owns the profile and saves it.
 * The work prompt (profile.context) is edited by the stage itself.
 */
export default function WorkProfileFields({ profile, projects, onChange }: {
  profile: McWorkProfile;
  projects: Array<{ projectId: string; displayName: string }>;
  onChange: (profile: McWorkProfile) => void;
}) {
  const { models, loading, error: modelError, refresh } = useProviderModels(profile.provider);
  const inventory = useMcpCatalog();
  const update = (patch: Partial<McWorkProfile>) => onChange({ ...profile, ...patch });
  const updateRoute = (index: number, patch: Partial<McWorkProfile['routes'][number]>) => update({ routes: profile.routes.map((route, i) => i === index ? { ...route, ...patch } : route) });
  const efforts = models.find((model) => model.value === profile.model)?.effort?.values ?? [];
  const names = [...new Set([...inventory.items.map((item) => item.name), ...profile.mcp_servers])];
  const projectOptions = (value: string | null) => <>{value && !projects.some((project) => project.projectId === value) ? <option value={value}>Missing project</option> : null}{projects.map((project) => <option key={project.projectId} value={project.projectId}>{project.displayName}</option>)}</>;
  return <div className="space-y-4">
    <div className="grid gap-2 sm:grid-cols-3">
      <label className="block min-w-0 text-xs">Agent
        <select className="field mt-1 w-full" value={profile.provider} onChange={(event) => update({ provider: event.target.value as McProvider, model: '', effort: null })}>
          {MC_PROVIDERS.map((provider) => <option key={provider} value={provider}>{provider}</option>)}
        </select>
      </label>
      <label className="block min-w-0 text-xs">Model
        <select className="field mt-1 w-full" value={profile.model} onChange={(event) => {
          const levels = models.find((model) => model.value === event.target.value)?.effort?.values ?? [];
          update({ model: event.target.value, effort: levels.some((level) => level.value === profile.effort) ? profile.effort : null });
        }} disabled={loading}>
          <option value="">{loading ? 'Loading installed models…' : 'Select a model'}</option>
          {profile.model && !models.some((model) => model.value === profile.model) ? <option value={profile.model}>{profile.model} (unavailable)</option> : null}
          {models.map((model) => <option key={model.value} value={model.value}>{model.label}</option>)}
        </select>
      </label>
      <label className="block min-w-0 text-xs">Effort
        <select className="field mt-1 w-full" value={profile.effort ?? ''} onChange={(event) => update({ effort: event.target.value || null })} disabled={loading || (!efforts.length && !profile.effort)}>
          <option value="">{efforts.length ? 'Model default' : 'Set by model'}</option>
          {profile.effort && !efforts.some((level) => level.value === profile.effort) ? <option value={profile.effort}>{profile.effort} (unsupported)</option> : null}
          {efforts.map((level) => <option key={level.value} value={level.value}>{level.value}</option>)}
        </select>
      </label>
    </div>
    <div className="flex flex-wrap items-center gap-2"><Button size="sm" variant="ghost" onClick={refresh} disabled={loading}>Refresh models</Button>{modelError ? <span role="alert" className="text-xs text-destructive">{modelError}</span> : !loading && !models.length ? <span className="text-xs text-muted-foreground">No models found. Install and sign in to {profile.provider}, then refresh.</span> : null}</div>
    <fieldset className="space-y-2"><legend className="text-xs font-semibold">Session MCP servers <span className="font-normal text-muted-foreground">· optional; must be enabled for {profile.provider} in Settings → MCP</span></legend>
      {inventory.loadError ? <p role="alert" className="text-xs text-destructive">{inventory.loadError}</p> : null}
      <div className="flex flex-wrap gap-3">{names.map((name) => {
        const selected = profile.mcp_servers.includes(name);
        const reason = workMcpUnavailableReason(inventory.items.find((item) => item.name === name), profile.provider);
        return <label key={name} className="flex items-center gap-1.5 text-xs" title={reason ?? undefined}>
          <input type="checkbox" checked={selected} disabled={Boolean(reason) && !selected} onChange={(event) => update({ mcp_servers: event.target.checked ? [...profile.mcp_servers, name] : profile.mcp_servers.filter((entry) => entry !== name) })} />
          <span>{name}{reason ? <span className={selected ? 'ml-1 text-destructive' : 'ml-1 text-muted-foreground'}> — {reason}</span> : null}</span>
        </label>;
      })}</div>
      <Button size="sm" variant="ghost" disabled={inventory.isLoading || inventory.isEnriching} onClick={() => void inventory.refresh({ bypassCache: true })}>Refresh MCP servers</Button>
    </fieldset>
    <label className="block text-xs">Default project<select className="field mt-1 w-full" value={profile.default_project_id ?? ''} onChange={(event) => update({ default_project_id: event.target.value || null })}><option value="">None — use client mappings only</option>{projectOptions(profile.default_project_id)}</select><span className="mt-1 block text-[11px] text-muted-foreground">Used when an item’s client matches no mapping.</span></label>
    <div className="space-y-2">
      <p className="text-xs font-semibold">Client → project mappings <span className="font-normal text-muted-foreground">· optional; a unique client or alias match wins over the default</span></p>
      {profile.routes.map((route, index) => <div key={index} className="space-y-2 rounded-lg border border-border p-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="min-w-0 text-xs">Client<input className="field mt-1 w-full" value={route.client} onChange={(event) => updateRoute(index, { client: event.target.value })} placeholder="VAST Data" /></label>
          <label className="min-w-0 text-xs">Project<select className="field mt-1 w-full" value={route.project_id} onChange={(event) => updateRoute(index, { project_id: event.target.value })}><option value="">Select a project</option>{projectOptions(route.project_id || null)}</select></label>
        </div>
        <label className="block text-xs">Aliases (comma separated)<input className="field mt-1 w-full" value={route.aliases.join(',')} onChange={(event) => updateRoute(index, { aliases: event.target.value.split(',') })} placeholder="VAST,VastData" /></label>
        <label className="block text-xs">Client context<textarea className="field mt-1 min-h-16 w-full" value={route.context} onChange={(event) => updateRoute(index, { context: event.target.value })} placeholder="MCP workspace/project identifier, client instructions, and relevant context locations" /></label>
        <Button size="sm" variant="ghost" onClick={() => update({ routes: profile.routes.filter((_, i) => i !== index) })}>Remove mapping</Button>
      </div>)}
      <Button size="sm" variant="outline" onClick={() => update({ routes: [...profile.routes, { client: '', aliases: [], project_id: '', context: '' }] })}>Add client mapping</Button>
    </div>
  </div>;
}
