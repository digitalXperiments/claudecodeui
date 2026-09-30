import { useState } from 'react';
import { FilePlus2, Link2, Loader2, Sparkles } from 'lucide-react';

import { botRuntimeApi } from '../../../../api/botRuntimeApi';
import { removeById, upsertSkill } from '../../../../hooks/botRuntimeReducers';
import type { BotEpisode, BotSkill } from '../../../../types/botRuntime';
import Toggle from '../../../../ui/Toggle';
import { Chip, EmptyLine, ErrorLine, Field, Panel, SkeletonRows } from '../panel/Panel';
import { useAsyncAction } from '../panel/useAsyncAction';

import SkillEditor from './SkillEditor';
import { SKILL_ORIGIN_LABELS, SKILL_ORIGIN_TONES, skillTemplate, slugifySkillName, sortSkills, validateSkillName } from './learningHelpers';

type Mode = 'none' | 'new' | 'from-run' | 'link';

/** The bot's skills: enable/disable, edit SKILL.md, create (blank, from a past run, or linked from the catalog). */
export default function SkillsPanel({ botId, skills, loading, loadError, episodes, selected, onSelect, patch }: {
  botId: string;
  skills: BotSkill[];
  loading: boolean;
  loadError: string | null;
  episodes: BotEpisode[];
  selected: string | null;
  onSelect: (name: string | null) => void;
  patch: (update: (current: BotSkill[]) => BotSkill[]) => void;
}) {
  const action = useAsyncAction();
  const [mode, setMode] = useState<Mode>('none');
  const [name, setName] = useState('');
  const [source, setSource] = useState<'episode' | 'run'>('episode');
  const [episodeId, setEpisodeId] = useState('');
  const [runId, setRunId] = useState('');
  const [path, setPath] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const sorted = sortSkills(skills);
  const selectedSkill = selected ? skills.find((skill) => skill.name === selected) ?? null : null;
  const finished = episodes.filter((episode) => episode.status !== 'running');

  const close = () => { setMode('none'); setName(''); setPath(''); setRunId(''); setEpisodeId(''); setFormError(null); };
  const apply = (skill: BotSkill) => { patch((current) => upsertSkill(current, skill)); onSelect(skill.name); close(); };

  const create = async () => {
    const problem = validateSkillName(name);
    if (problem) return setFormError(problem);
    setFormError(null);
    await action.run('create', async () => apply(await botRuntimeApi.skills.save(botId, name, { content: skillTemplate(name), enabled: false })));
  };

  const fromRun = async () => {
    const ref = source === 'episode' ? { episodeId } : { runId: runId.trim() };
    if (!ref.episodeId && !ref.runId) return setFormError(source === 'episode' ? 'Pick an episode.' : 'Enter a run id.');
    setFormError(null);
    await action.run('from-run', async () => apply(await botRuntimeApi.skills.fromRun(botId, ref)));
  };

  const link = async () => {
    if (!path.trim()) return setFormError('Enter the path to a SKILL.md or its folder.');
    setFormError(null);
    await action.run('link', async () => apply(await botRuntimeApi.skills.linkCatalog(botId, path.trim())));
  };

  const setEnabled = (skill: BotSkill, enabled: boolean) => void action.run(skill.name, async () => {
    patch((current) => upsertSkill(current, { ...skill, enabled }));
    try {
      const next = await botRuntimeApi.skills.setEnabled(botId, skill.name, enabled);
      patch((current) => upsertSkill(current, next));
    } catch (caught) {
      patch((current) => upsertSkill(current, skill));
      throw caught;
    }
  });

  return (
    <div className="space-y-4">
      <Panel
        title="Skills"
        description="Reusable know-how the bot reads before it acts. A skill must be enabled to be used; new ones from the reflector or teach mode start disabled so you can review them."
        actions={(
          <>
            <button type="button" className="button min-h-8" onClick={() => setMode(mode === 'new' ? 'none' : 'new')}><FilePlus2 className="h-3.5 w-3.5" aria-hidden="true" />New</button>
            <button type="button" className="button min-h-8" onClick={() => setMode(mode === 'from-run' ? 'none' : 'from-run')}><Sparkles className="h-3.5 w-3.5" aria-hidden="true" />From a run</button>
            <button type="button" className="button min-h-8" onClick={() => setMode(mode === 'link' ? 'none' : 'link')}><Link2 className="h-3.5 w-3.5" aria-hidden="true" />Link catalog skill</button>
          </>
        )}
      >
        <div className="space-y-2">
          {mode === 'new' ? (
            <form className="space-y-2 rounded-lg border border-primary/30 p-3" onSubmit={(event) => { event.preventDefault(); void create(); }} aria-label="New skill">
              <Field label="Skill name" hint="Lowercase letters, digits and dashes.">
                <input aria-label="Skill name" className="field h-9 font-mono text-xs" placeholder="jira-triage" value={name} onChange={(event) => setName(slugifySkillName(event.target.value) || event.target.value.toLowerCase())} />
              </Field>
              <FormActions error={formError ?? action.error} busy={action.isBusy('create')} label="Create skill" onCancel={close} />
            </form>
          ) : null}
          {mode === 'from-run' ? (
            <form className="space-y-2 rounded-lg border border-primary/30 p-3" onSubmit={(event) => { event.preventDefault(); void fromRun(); }} aria-label="Create skill from a run">
              <p className="text-[11px] text-muted-foreground">Drafts a skill from the steps a past run executed. It takes a moment (a model writes the draft) and is saved disabled.</p>
              <div className="flex gap-3 text-xs">
                <label className="flex items-center gap-1.5"><input type="radio" checked={source === 'episode'} onChange={() => setSource('episode')} />An episode</label>
                <label className="flex items-center gap-1.5"><input type="radio" checked={source === 'run'} onChange={() => setSource('run')} />A run id</label>
              </div>
              {source === 'episode' ? (
                <select aria-label="Episode" className="field h-9" value={episodeId} onChange={(event) => setEpisodeId(event.target.value)}>
                  <option value="">Pick an episode…</option>
                  {finished.map((episode) => <option key={episode.episode_id} value={episode.episode_id}>{(episode.summary || episode.trigger_kinds || episode.episode_id).slice(0, 80)} · {episode.status}</option>)}
                </select>
              ) : <input aria-label="Run id" className="field h-9 font-mono text-xs" placeholder="run id" value={runId} onChange={(event) => setRunId(event.target.value)} />}
              <FormActions error={formError ?? action.error} busy={action.isBusy('from-run')} label="Draft skill" onCancel={close} />
            </form>
          ) : null}
          {mode === 'link' ? (
            <form className="space-y-2 rounded-lg border border-primary/30 p-3" onSubmit={(event) => { event.preventDefault(); void link(); }} aria-label="Link a catalog skill">
              <Field label="Path to SKILL.md (or its folder)" hint="Must be inside a known skills catalog. The skill is linked read-only.">
                <input aria-label="Catalog skill path" className="field h-9 font-mono text-xs" placeholder="~/.claude/skills/my-skill" value={path} onChange={(event) => setPath(event.target.value)} />
              </Field>
              <FormActions error={formError ?? action.error} busy={action.isBusy('link')} label="Link skill" onCancel={close} />
            </form>
          ) : null}

          {mode === 'none' ? <ErrorLine message={action.error} /> : null}
          {loading && skills.length === 0 ? <SkeletonRows /> : null}
          {loadError && skills.length === 0 ? <ErrorLine message={loadError} /> : null}
          {!loading && !loadError && skills.length === 0 ? <EmptyLine>No skills yet. Create one, draft one from a run, or use teach mode.</EmptyLine> : null}
          {sorted.length > 0 ? (
            <ul className="space-y-1.5">
              {sorted.map((skill) => (
                <li key={skill.link_id} className={`flex items-center gap-3 rounded-xl border bg-card px-3 py-2 ${selected === skill.name ? 'border-primary/50' : 'border-border/70'}`}>
                  <button type="button" className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onSelect(selected === skill.name ? null : skill.name)} aria-expanded={selected === skill.name}>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-xs font-medium">{skill.name}</span>
                      <Chip className={SKILL_ORIGIN_TONES[skill.origin] ?? SKILL_ORIGIN_TONES.manual}>{SKILL_ORIGIN_LABELS[skill.origin] ?? skill.origin}</Chip>
                      <span className="text-[10px] text-muted-foreground">v{skill.version}</span>
                      {skill.readonly ? <span className="text-[10px] text-muted-foreground">read-only</span> : null}
                    </span>
                    {skill.description ? <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{skill.description}</span> : null}
                  </button>
                  <Toggle checked={skill.enabled} onChange={(enabled) => setEnabled(skill, enabled)} label={`${skill.enabled ? 'Disable' : 'Enable'} skill ${skill.name}`} disabled={action.isBusy(skill.name)} />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </Panel>
      {selectedSkill ? (
        <SkillEditor
          key={selectedSkill.name}
          botId={botId}
          skill={selectedSkill}
          onSaved={(skill) => patch((current) => upsertSkill(current, skill))}
          onRemoved={(removed) => { patch((current) => removeById(current, removed, (entry) => entry.name)); onSelect(null); }}
          onClose={() => onSelect(null)}
        />
      ) : null}
    </div>
  );
}

function FormActions({ error, busy, label, onCancel }: { error: string | null; busy: boolean; label: string; onCancel: () => void }) {
  return (
    <>
      <ErrorLine message={error} />
      <div className="flex justify-end gap-2">
        <button type="button" className="button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="button button-primary" disabled={busy}>{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}{label}</button>
      </div>
    </>
  );
}
