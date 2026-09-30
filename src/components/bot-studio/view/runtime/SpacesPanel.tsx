import { FilePlus2, FileText, Pencil, Save, Trash2 } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

import { botRuntimeApi } from '../../api/botRuntimeApi';
import type { BotSpace, BotSpaceContent } from '../../types/botRuntime';

import { EmptyLine, ErrorBanner, Field, LoadingLine, Pill, RuntimeCard } from './RuntimePage';
import { rootOptions, sortSpaces, spaceFileName, validateSpaceTitle } from './teamsModel';
import { errorText, useLoad } from './useLoad';

function SpaceViewer({ botId, space, onChanged, onDeleted, onNotice }: {
  botId: string;
  space: BotSpace;
  onChanged: (space: BotSpace) => void;
  onDeleted: () => void;
  onNotice?: (message: string, tone: 'default' | 'error' | 'success') => void;
}) {
  const fetchContent = useCallback(() => botRuntimeApi.collab.getSpace(botId, space.space_id), [botId, space.space_id]);
  const { data, setData, error, loading, reload } = useLoad<BotSpaceContent>(fetchContent, `${botId}:${space.space_id}`);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const save = async () => {
    if (draft === null) return;
    setSaving(true);
    setActionError(null);
    try {
      const updated = await botRuntimeApi.collab.writeSpace(botId, space.space_id, draft, 'replace');
      setData({ space: updated, content: draft, truncated: false });
      setDraft(null);
      onChanged(updated);
      onNotice?.('Space saved.', 'success');
    } catch (caught) {
      setActionError(errorText(caught, 'Unable to save the space.'));
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    if (!window.confirm(`Delete the space "${space.title}"?`)) return;
    try {
      await botRuntimeApi.collab.deleteSpace(botId, space.space_id);
      onDeleted();
    } catch (caught) {
      setActionError(errorText(caught, 'Unable to delete the space.'));
    }
  };

  return <div className="min-w-0 flex-1">
    <div className="flex flex-wrap items-center gap-2 border-b border-border/70 px-4 py-3">
      <div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold">{space.title}</p><p className="truncate font-mono text-[10px] text-muted-foreground" title={space.path}>{space.path}</p></div>
      {draft === null
        ? <button type="button" className="button" onClick={() => setDraft(data?.content ?? '')} disabled={!data || data.truncated} title={data?.truncated ? 'Too large to edit here: only part of the file was loaded' : undefined}><Pencil className="h-3.5 w-3.5" />Edit</button>
        : <><button type="button" className="button" onClick={() => setDraft(null)} disabled={saving}>Cancel</button><button type="button" className="button button-primary" onClick={() => void save()} disabled={saving}><Save className="h-3.5 w-3.5" />{saving ? 'Saving…' : 'Save'}</button></>}
      <button type="button" className="icon-button hover:text-destructive" onClick={() => void remove()} aria-label={`Delete space ${space.title}`}><Trash2 className="h-3.5 w-3.5" /></button>
    </div>
    <div className="p-4">
      {error ? <ErrorBanner message={error} onRetry={() => void reload()} /> : null}
      {actionError ? <ErrorBanner message={actionError} /> : null}
      {!data && loading ? <LoadingLine label="Loading the space…" /> : null}
      {data?.truncated ? <p className="mb-2 text-[11px] text-amber-700 dark:text-amber-300">This file is large; only the beginning is shown, and editing is disabled so the rest is never overwritten.</p> : null}
      {data && draft === null ? <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/70 bg-muted/30 p-3 font-mono text-[11px] leading-relaxed" aria-label={`Contents of ${space.title}`}>{data.content || '(empty)'}</pre> : null}
      {draft !== null ? <textarea className="field min-h-80 font-mono text-[11px]" value={draft} onChange={(event) => setDraft(event.target.value)} aria-label={`Edit ${space.title}`} spellCheck={false} /> : null}
    </div>
  </div>;
}

function CreateSpaceForm({ botId, onCreated, onCancel }: { botId: string; onCreated: (space: BotSpace) => void; onCancel: () => void }) {
  const fetchRoots = useCallback(() => botRuntimeApi.collab.spaceRoots(), []);
  const { data: rawRoots } = useLoad(fetchRoots, 'roots');
  const roots = useMemo(() => rootOptions(rawRoots ?? []), [rawRoots]);
  const [title, setTitle] = useState('');
  const [root, setRoot] = useState('');
  const [content, setContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const create = async () => {
    const problem = validateSpaceTitle(title);
    if (problem) { setError(problem); return; }
    setSaving(true);
    setError(null);
    try {
      onCreated(await botRuntimeApi.collab.createSpace(botId, { title: title.trim(), ...(root ? { root } : {}), ...(content.trim() ? { content } : {}) }));
    } catch (caught) {
      setError(errorText(caught, 'Unable to create the space.'));
    } finally {
      setSaving(false);
    }
  };

  return <div className="space-y-3 border-b border-border/70 bg-muted/20 p-4">
    {error ? <ErrorBanner message={error} /> : null}
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Title"><input className="field" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Research notes" maxLength={120} /></Field>
      <Field label="Location" hint={roots.length ? 'Default keeps the file inside the bot\'s own home.' : 'No external roots are allow-listed (CLOUDCLI_SPACES_ROOTS), so the file lives in the bot\'s home.'}>
        <select className="field" value={root} onChange={(event) => setRoot(event.target.value)}><option value="">Bot home (default)</option>{roots.map((entry) => <option key={entry} value={entry}>{entry}</option>)}</select>
      </Field>
    </div>
    <Field label="Initial content (optional, markdown)"><textarea className="field min-h-24 font-mono text-[11px]" value={content} onChange={(event) => setContent(event.target.value)} spellCheck={false} /></Field>
    <div className="flex justify-end gap-2"><button type="button" className="button" onClick={onCancel} disabled={saving}>Cancel</button><button type="button" className="button button-primary" onClick={() => void create()} disabled={saving}>{saving ? 'Creating…' : 'Create space'}</button></div>
  </div>;
}

/** Per-bot shared spaces: markdown files the bot and operator can both read and write. */
export default function SpacesPanel({ botId, onNotice }: { botId: string; onNotice?: (message: string, tone: 'default' | 'error' | 'success') => void }) {
  const fetchSpaces = useCallback(() => botRuntimeApi.collab.listSpaces(botId), [botId]);
  const { data, setData, error, loading, reload } = useLoad(fetchSpaces, botId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const spaces = useMemo(() => sortSpaces(data ?? []), [data]);
  const selected = spaces.find((space) => space.space_id === selectedId) ?? null;

  return <RuntimeCard title="Spaces" subtitle="Shared markdown files for this bot" action={<button type="button" className="button" onClick={() => setCreating((open) => !open)}><FilePlus2 className="h-3.5 w-3.5" />New space</button>}>
    {creating ? <CreateSpaceForm botId={botId} onCancel={() => setCreating(false)} onCreated={(space) => { setData((current) => [...(current ?? []), space]); setSelectedId(space.space_id); setCreating(false); onNotice?.('Space created.', 'success'); }} /> : null}
    {error ? <div className="p-3"><ErrorBanner message={error} onRetry={() => void reload()} /></div> : null}
    {!data && loading ? <LoadingLine label="Loading spaces…" /> : null}
    {data && !spaces.length && !creating ? <EmptyLine>This bot has no spaces yet. Create one to share notes with it.</EmptyLine> : null}
    {spaces.length ? <div className="flex flex-col md:flex-row">
      <ul className="shrink-0 divide-y divide-border/50 border-b border-border/70 md:w-64 md:border-b-0 md:border-r" aria-label="Spaces">{spaces.map((space) => <li key={space.space_id}><button type="button" onClick={() => setSelectedId(space.space_id)} aria-current={space.space_id === selectedId} className={`flex w-full items-start gap-2 px-4 py-2.5 text-left hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${space.space_id === selectedId ? 'bg-primary/5' : ''}`}><FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" /><span className="min-w-0"><span className="block truncate text-xs font-medium">{space.title}</span><span className="block truncate text-[10px] text-muted-foreground">{spaceFileName(space)}</span></span><Pill>{space.kind}</Pill></button></li>)}</ul>
      {selected ? <SpaceViewer key={selected.space_id} botId={botId} space={selected} onChanged={(updated) => setData((current) => (current ?? []).map((entry) => (entry.space_id === updated.space_id ? updated : entry)))} onDeleted={() => { setData((current) => (current ?? []).filter((entry) => entry.space_id !== selected.space_id)); setSelectedId(null); onNotice?.('Space deleted.', 'success'); }} onNotice={onNotice} /> : <div className="flex flex-1 items-center justify-center p-8 text-[11px] text-muted-foreground">Select a space to read it.</div>}
    </div> : null}
  </RuntimeCard>;
}
