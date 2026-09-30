import { Field } from '../panel/Panel';

import {
  GITHUB_WHAT, WATCH_ADAPTER_LABELS, WATCH_ADAPTERS, tccFolder,
  type IntervalUnit, type TriggerDraft, type WatchAdapterKind,
} from './triggerForm';

type Props = { draft: TriggerDraft; onChange: (patch: Partial<TriggerDraft>) => void };

/** Fields for `watch` triggers, per adapter. */
export default function WatchFields({ draft, onChange }: Props) {
  const tcc = draft.adapter === 'directory' ? tccFolder(draft.path) : null;
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-3">
        <Field label="Adapter">
          <select aria-label="Watch adapter" className="field h-9" value={draft.adapter} onChange={(event) => onChange({ adapter: event.target.value as WatchAdapterKind })}>
            {WATCH_ADAPTERS.map((adapter) => <option key={adapter} value={adapter}>{WATCH_ADAPTER_LABELS[adapter]}</option>)}
          </select>
        </Field>
        <Field label="Poll every">
          <div className="flex gap-1.5">
            <input aria-label="Poll interval" type="number" min="1" step="any" className="field h-9 w-20" value={draft.watchIntervalValue} onChange={(event) => onChange({ watchIntervalValue: event.target.value })} />
            <select aria-label="Poll interval unit" className="field h-9" value={draft.watchIntervalUnit} onChange={(event) => onChange({ watchIntervalUnit: event.target.value as IntervalUnit })}>
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
              <option value="days">days</option>
            </select>
          </div>
        </Field>
        <label className="flex items-end gap-2 pb-2 text-[11px] text-muted-foreground">
          <input type="checkbox" checked={draft.emitExisting} onChange={(event) => onChange({ emitExisting: event.target.checked })} />
          Also wake for what already exists
        </label>
      </div>

      {draft.adapter === 'rss' ? (
        <Field label="Feed URL">
          <input aria-label="Feed URL" className="field h-9" placeholder="https://example.com/feed.xml" value={draft.url} onChange={(event) => onChange({ url: event.target.value })} />
        </Field>
      ) : null}

      {draft.adapter === 'directory' ? (
        <div className="space-y-2">
          <Field label="Directory path" hint="New and changed files wake the bot. The server runs without access to Documents, Desktop and Downloads (macOS privacy protection), so pick a folder elsewhere.">
            <input aria-label="Directory path" className="field h-9 font-mono text-xs" placeholder="~/watched/inbox" value={draft.path} onChange={(event) => onChange({ path: event.target.value })} />
          </Field>
          {tcc ? <p role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">~/{tcc} is protected by macOS and cannot be read by the CloudCLI server. Move the folder out of it.</p> : null}
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Filename pattern (regex, optional)">
              <input aria-label="Filename pattern" className="field h-9 font-mono text-xs" placeholder="\.pdf$" value={draft.pattern} onChange={(event) => onChange({ pattern: event.target.value })} />
            </Field>
            <label className="flex items-end gap-2 pb-2 text-[11px] text-muted-foreground">
              <input type="checkbox" checked={draft.includeHidden} onChange={(event) => onChange({ includeHidden: event.target.checked })} />
              Include hidden files
            </label>
          </div>
        </div>
      ) : null}

      {draft.adapter === 'github' ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Repository" hint="Uses your GitHub credentials on this machine.">
            <input aria-label="GitHub repository" className="field h-9 font-mono text-xs" placeholder="owner/name" value={draft.repo} onChange={(event) => onChange({ repo: event.target.value })} />
          </Field>
          <fieldset className="min-w-0">
            <legend className="text-[11px] text-muted-foreground">Watch for</legend>
            <div className="mt-2 flex flex-wrap gap-3 text-xs">
              {GITHUB_WHAT.map((what) => (
                <label key={what} className="flex items-center gap-1.5">
                  <input type="checkbox" checked={draft.what.includes(what)} onChange={(event) => onChange({ what: event.target.checked ? [...draft.what, what] : draft.what.filter((entry) => entry !== what) })} />
                  {what}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      ) : null}

      {draft.adapter === 'http_json' ? (
        <div className="space-y-2">
          <Field label="Endpoint URL">
            <input aria-label="Endpoint URL" className="field h-9" placeholder="https://api.example.com/items" value={draft.url} onChange={(event) => onChange({ url: event.target.value })} />
          </Field>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Id field" hint="The field that uniquely identifies each item, so only new ones wake the bot.">
              <input aria-label="Id field" className="field h-9 font-mono text-xs" placeholder="id" value={draft.idField} onChange={(event) => onChange({ idField: event.target.value })} />
            </Field>
            <Field label="Items path (optional)" hint="Where the array lives in the response, for example data.items.">
              <input aria-label="Items path" className="field h-9 font-mono text-xs" value={draft.itemsPath} onChange={(event) => onChange({ itemsPath: event.target.value })} />
            </Field>
          </div>
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <Field label="Auth header (optional)">
              <input aria-label="Header name" className="field h-9" placeholder="Authorization" value={draft.headerName} onChange={(event) => onChange({ headerName: event.target.value })} />
            </Field>
            <Field label="Header secret name" hint="The name of a secret in Settings → Secrets. The value is never shown here.">
              <input aria-label="Header secret name" className="field h-9 font-mono text-xs" placeholder="MY_API_TOKEN" value={draft.headerSecret} onChange={(event) => onChange({ headerSecret: event.target.value })} />
            </Field>
            <Field label="Prefix">
              <select aria-label="Header prefix" className="field h-9" value={draft.headerPrefix} onChange={(event) => onChange({ headerPrefix: event.target.value as '' | 'Bearer ' })}>
                <option value="">none</option>
                <option value="Bearer ">Bearer</option>
              </select>
            </Field>
          </div>
          {Object.keys(draft.extraHeaders).length > 0 ? <p className="text-[10px] text-muted-foreground">Other headers ({Object.keys(draft.extraHeaders).join(', ')}) are kept as they are.</p> : null}
        </div>
      ) : null}
    </div>
  );
}
