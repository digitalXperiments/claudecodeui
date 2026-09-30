import { useEffect, useState } from 'react';
import { Loader2, Save, Trash2, X } from 'lucide-react';

import { botRuntimeApi } from '../../../../api/botRuntimeApi';
import type { BotSkill } from '../../../../types/botRuntime';
import { ErrorLine, Panel, SkeletonRows } from '../panel/Panel';
import { useAsyncAction } from '../panel/useAsyncAction';
import { useRemote } from '../panel/useRemote';

import { skillContentProblem } from './learningHelpers';

/** Edits one skill's SKILL.md in a monospace textarea. Catalog skills are read-only and can only be unlinked. */
export default function SkillEditor({ botId, skill, onSaved, onRemoved, onClose }: {
  botId: string;
  skill: BotSkill;
  onSaved: (skill: BotSkill) => void;
  onRemoved: (name: string) => void;
  onClose: () => void;
}) {
  const { data, error, loading } = useRemote(() => botRuntimeApi.skills.get(botId, skill.name), `${botId}|${skill.name}|${skill.version}`);
  const action = useAsyncAction();
  const [content, setContent] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (data) {
      setContent(data.content);
      setSaved(false);
    }
  }, [data]);

  const readonly = skill.readonly;
  const dirty = data !== null && content !== data.content;
  const problem = readonly ? null : skillContentProblem(content);

  const save = async () => {
    if (problem) return;
    const ok = await action.run('save', async () => onSaved(await botRuntimeApi.skills.save(botId, skill.name, { content })));
    setSaved(ok);
  };

  const remove = () => {
    const what = readonly ? `Unlink ${skill.name}? The shared skill itself is not deleted.` : `Delete ${skill.name}? Its SKILL.md is removed.`;
    if (!window.confirm(what)) return;
    void action.run('remove', async () => {
      await botRuntimeApi.skills.remove(botId, skill.name);
      onRemoved(skill.name);
    });
  };

  return (
    <Panel
      title={`SKILL.md · ${skill.name}`}
      description={readonly ? 'Linked from the shared skills catalog, so it is read-only here.' : `Version ${skill.version}. Saving bumps the version.`}
      actions={<button type="button" className="icon-button" onClick={onClose} aria-label="Close editor"><X className="h-4 w-4" /></button>}
    >
      {loading && !data ? <SkeletonRows count={2} /> : null}
      <ErrorLine message={error} />
      {data ? (
        <div className="space-y-2">
          <textarea
            aria-label={`SKILL.md for ${skill.name}`}
            className="field min-h-72 w-full resize-y font-mono text-xs leading-relaxed"
            spellCheck={false}
            readOnly={readonly}
            value={content}
            onChange={(event) => { setContent(event.target.value); setSaved(false); }}
          />
          <ErrorLine message={action.error ?? (dirty ? problem : null)} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button type="button" className="button min-h-8 text-destructive hover:bg-destructive/10" onClick={remove} disabled={action.busy}><Trash2 className="h-3.5 w-3.5" aria-hidden="true" />{readonly ? 'Unlink' : 'Delete'}</button>
            {!readonly ? (
              <div className="flex items-center gap-2">
                {saved && !dirty ? <span role="status" className="text-[11px] text-emerald-700 dark:text-emerald-300">Saved</span> : null}
                <button type="button" className="button button-primary" onClick={() => void save()} disabled={!dirty || Boolean(problem) || action.busy}>{action.isBusy('save') ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" aria-hidden="true" />}Save</button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </Panel>
  );
}
