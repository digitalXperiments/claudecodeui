import { useRef, useState } from 'react';
import { KeyRound, Loader2, Trash2 } from 'lucide-react';

import { botRuntimeApi } from '../../../../api/botRuntimeApi';
import type { BotCredentialName } from '../../../../types/botRuntime';
import { EmptyLine, ErrorLine, Field, Panel, SkeletonRows } from '../panel/Panel';
import { relativeTime } from '../panel/time';
import { useAsyncAction } from '../panel/useAsyncAction';
import { useRemote } from '../panel/useRemote';

import { groupCredentials, validateCredentialInput } from './ruleHelpers';

/**
 * Per-bot credentials for MCP servers. Only names and timestamps are ever shown: the API never
 * returns values, and the value typed here is cleared as soon as it is sent.
 */
export default function CredentialsCard({ botId, serverSuggestions, now }: { botId: string; serverSuggestions: string[]; now: number }) {
  const { data, error, loading, setData } = useRemote(() => botRuntimeApi.exec.listCredentials(botId), botId);
  const action = useAsyncAction();
  const [server, setServer] = useState('');
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const valueRef = useRef<HTMLInputElement>(null);
  const groups = groupCredentials(data ?? []);

  const upsert = (entry: BotCredentialName) => setData((current) => {
    const list = current ?? [];
    const rest = list.filter((item) => !(item.server === entry.server && item.key === entry.key));
    return [...rest, entry];
  });

  const save = async () => {
    const problem = validateCredentialInput({ server, key: key.trim(), value });
    if (problem) {
      setFormError(problem);
      return;
    }
    setFormError(null);
    setNotice(null);
    const secret = value;
    setValue('');
    const ok = await action.run('set', async () => {
      upsert(await botRuntimeApi.exec.setCredential(botId, server.trim(), key.trim(), secret));
    });
    if (ok) setNotice(`Saved ${key.trim()}. The value is stored encrypted and is not shown again.`);
  };

  const remove = (entry: BotCredentialName) => {
    if (!window.confirm(`Delete ${entry.key} for ${entry.server}? The bot falls back to the shared setting for that server.`)) return;
    void action.run(entry.name, async () => {
      await botRuntimeApi.exec.removeCredential(botId, entry.server, entry.key);
      setData((current) => (current ?? []).filter((item) => item.name !== entry.name));
    });
  };

  const replace = (entry: BotCredentialName) => {
    setServer(entry.server);
    setKey(entry.key);
    setValue('');
    setNotice(null);
    valueRef.current?.focus();
  };

  return (
    <Panel
      title="Credentials"
      description="Give this bot its own login for an MCP server (for example a separate Jira account) instead of the shared one. The gateway injects it at call time; it never enters the prompt. Values are write-only."
    >
      <div className="space-y-3">
        {loading && !data ? <SkeletonRows count={1} /> : null}
        <ErrorLine message={error} />
        {data && groups.length === 0 ? <EmptyLine>No per-bot credentials. This bot uses the shared server settings.</EmptyLine> : null}
        {groups.map((group) => (
          <div key={group.server} className="rounded-lg border border-border/60">
            <p className="flex items-center gap-1.5 border-b border-border/50 px-3 py-1.5 text-[11px] font-semibold"><KeyRound className="h-3 w-3 text-muted-foreground" aria-hidden="true" />{group.server}</p>
            <ul className="divide-y divide-border/50">
              {group.entries.map((entry) => (
                <li key={entry.name} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
                  <code className="min-w-0 flex-1 truncate font-mono text-[11px]">{entry.key}</code>
                  <span className="text-[10px] text-muted-foreground">set {relativeTime(entry.updated_at, now)} · {entry.last_used_at ? `used ${relativeTime(entry.last_used_at, now)}` : 'never used'}</span>
                  <button type="button" className="button min-h-7 px-2" onClick={() => replace(entry)}>Replace</button>
                  <button type="button" className="icon-button h-7 w-7 text-destructive" aria-label={`Delete ${entry.key} for ${entry.server}`} disabled={action.isBusy(entry.name)} onClick={() => remove(entry)}><Trash2 className="h-3.5 w-3.5" /></button>
                </li>
              ))}
            </ul>
          </div>
        ))}

        <form className="space-y-2 rounded-lg border border-border/60 bg-background p-3" onSubmit={(event) => { event.preventDefault(); void save(); }} aria-label="Set credential" autoComplete="off">
          <p className="text-[11px] font-medium">Set or replace a credential</p>
          <div className="grid gap-2 sm:grid-cols-3">
            <Field label="MCP server">
              <input aria-label="Credential server" list="bot-credential-servers" className="field h-9" placeholder="jira-cloud" value={server} onChange={(event) => setServer(event.target.value)} />
              <datalist id="bot-credential-servers">{serverSuggestions.map((name) => <option key={name} value={name} />)}</datalist>
            </Field>
            <Field label="Env var or header">
              <input aria-label="Credential key" className="field h-9 font-mono text-xs" placeholder="JIRA_API_TOKEN" value={key} onChange={(event) => setKey(event.target.value)} />
            </Field>
            <Field label="Value">
              <input ref={valueRef} aria-label="Credential value" type="password" autoComplete="new-password" className="field h-9" value={value} onChange={(event) => setValue(event.target.value)} />
            </Field>
          </div>
          <p className="text-[10px] text-muted-foreground">Use the same name the server expects: an env var for local (stdio) servers, a header such as x-api-key for remote ones.</p>
          <ErrorLine message={formError ?? action.error} />
          {notice ? <p role="status" className="text-[11px] text-emerald-700 dark:text-emerald-300">{notice}</p> : null}
          <div className="flex justify-end">
            <button type="submit" className="button button-primary" disabled={action.isBusy('set')}>{action.isBusy('set') ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}Save credential</button>
          </div>
        </form>
      </div>
    </Panel>
  );
}
