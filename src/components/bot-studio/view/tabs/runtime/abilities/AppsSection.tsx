import { Plug, Save, Settings2, X } from 'lucide-react';
import { useState } from 'react';

import type { CreateMcSectionInput, McSection } from '../../../../../mission-control/api/missionControlApi';
import type { ToolPolicy } from '../../../../types';
import type { BotAbilities } from '../../../../types/botRuntime';
import { Pill } from '../../../runtime/RuntimePage';
import PhaseToolsEditor from '../../PhaseToolsEditor';
import { Chip, EmptyLine, ErrorLine, SkeletonRows } from '../panel/Panel';
import { useAsyncAction } from '../panel/useAsyncAction';

import AbilityCard from './AbilityCard';
import { appsHeadline, mergeToolPolicy, prettyServerName, toolCountsLabel } from './abilitiesModel';

type SaveFn = (patch: Partial<CreateMcSectionInput>) => Promise<void>;

function AppsEditor({ section, onSave, onSaved, onCancel }: { section: McSection; onSave: SaveFn; onSaved: () => void; onCancel: () => void }) {
  const [produce, setProduce] = useState<string[]>(section.produce_tools ?? []);
  const [resolve, setResolve] = useState<string[]>(section.resolve_tools ?? []);
  const [policy, setPolicy] = useState<ToolPolicy>((section.tool_policy ?? {}) as ToolPolicy);
  const action = useAsyncAction();
  const save = async () => {
    const attached = [...new Set([...produce, ...resolve])];
    const ok = await action.run('save', () => onSave({
      produce_tools: produce,
      resolve_tools: resolve,
      tool_policy: mergeToolPolicy(section.tool_policy, policy, attached),
    }));
    if (ok) onSaved();
  };
  return (
    <div className="space-y-4 rounded-xl border border-primary/25 bg-primary/[0.03] p-4">
      <p className="text-[11px] leading-relaxed text-muted-foreground">Add an app to give the bot a new ability, or remove one to take it away. For each tool you can allow it, make the bot ask first, or block it.</p>
      <div className="space-y-1.5">
        <p className="text-xs font-semibold">When it looks for things (Propose)</p>
        <PhaseToolsEditor phaseLabel="Propose" servers={produce} policy={policy} onServersChange={setProduce} onPolicyChange={setPolicy} />
      </div>
      <div className="space-y-1.5">
        <p className="text-xs font-semibold">When it acts on an item you approved (Resolve)</p>
        <PhaseToolsEditor phaseLabel="Resolve" servers={resolve} policy={policy} onServersChange={setResolve} onPolicyChange={setPolicy} />
      </div>
      <ErrorLine message={action.error} />
      <div className="flex flex-wrap gap-2">
        <button type="button" className="button button-primary" disabled={action.busy} onClick={() => void save()}><Save className="h-3.5 w-3.5" />{action.busy ? 'Saving…' : 'Save apps'}</button>
        <button type="button" className="button" disabled={action.busy} onClick={onCancel}><X className="h-3.5 w-3.5" />Cancel</button>
      </div>
    </div>
  );
}

/** Section 2: the MCP servers this bot may use, with the per-tool allow/ask/block counts. */
export default function AppsSection({ section, abilities, onSave, onChanged, onOpenPipeline }: {
  section: McSection;
  abilities: BotAbilities | null;
  onSave?: SaveFn;
  onChanged: () => void;
  onOpenPipeline: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const apps = abilities?.apps ?? [];
  return (
    <AbilityCard
      id="apps"
      number={2}
      title="Apps it can use"
      description="A bot can only use the apps listed here. If an app is not on this list, the bot cannot touch it, no matter what you ask."
      actions={onSave
        ? <button type="button" className="button" onClick={() => setEditing((open) => !open)} aria-expanded={editing}><Settings2 className="h-3.5 w-3.5" />{editing ? 'Close' : 'Change apps'}</button>
        : <button type="button" className="button" onClick={onOpenPipeline}><Settings2 className="h-3.5 w-3.5" />Change apps</button>}
    >
      {editing && onSave ? <AppsEditor section={section} onSave={onSave} onSaved={() => { setEditing(false); onChanged(); }} onCancel={() => setEditing(false)} /> : null}
      {!abilities ? <SkeletonRows count={2} /> : (
        <>
          <p className="text-xs font-medium">{appsHeadline(apps.length)}</p>
          {apps.length === 0 ? <EmptyLine>Use "Change apps" to attach Gmail, Slack, Jira or any other app you have connected.</EmptyLine> : (
            <ul className="divide-y divide-border/50 rounded-xl border border-border/60">
              {apps.map((app) => (
                <li key={app.server} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                  <Plug className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-xs font-semibold" title={app.server}>{prettyServerName(app.server)}</span>
                  <Pill tone={app.connected ? 'success' : 'warning'}>{app.connected ? 'Connected' : 'Not connected'}</Pill>
                  <Chip>{toolCountsLabel(app.tools_policy_counts)}</Chip>
                </li>
              ))}
            </ul>
          )}
          {apps.some((app) => !app.connected) ? <p className="text-[11px] text-amber-700 dark:text-amber-300">An app that is not connected cannot be used yet. Connect it in Settings → MCP.</p> : null}
        </>
      )}
    </AbilityCard>
  );
}
