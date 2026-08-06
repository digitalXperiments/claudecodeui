import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
  Copy,
  Loader2,
  Pencil,
  Play,
  Plus,
  Trash2,
  Webhook,
} from 'lucide-react';

import { Button, Input } from '../../../../../shared/view/ui';
import {
  webhooksApi,
  type WebhookDelivery,
  type WebhookSource,
  type WebhookSourceInput,
} from '../../../api/webhooksApi';
import { AGENT_NAMES, AGENT_PROVIDERS } from '../../../constants/constants';
import type { LLMProvider } from '../../../../../types/app';

const labelClass = 'text-xs font-medium text-muted-foreground';
const selectClass =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';
const textareaClass =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring min-h-[120px]';

const DEFAULT_PROMPT = `Summarize the following note into clear markdown.
If Obsidian MCP tools are available, store the result under Notes/Dictation/ with a sensible filename.
Do not invent content beyond the note.

Title: {{title}}
Captured: {{timestamp}}
Source: {{source}}

---
{{text}}`;

type Draft = {
  source: string;
  name: string;
  description: string;
  enabled: boolean;
  provider: LLMProvider;
  model: string;
  prompt: string;
  permission_mode: string;
  mcp_tools_text: string;
  skills_text: string;
  scope: 'global' | 'project';
  project_id: string;
  retryMax: string;
  retryBackoffSeconds: string;
  secret: string;
};

const emptyDraft = (): Draft => ({
  source: '',
  name: '',
  description: '',
  enabled: true,
  provider: 'claude',
  model: '',
  prompt: DEFAULT_PROMPT,
  permission_mode: 'bypassPermissions',
  mcp_tools_text: '',
  skills_text: '',
  scope: 'global',
  project_id: '',
  retryMax: '',
  retryBackoffSeconds: '',
  secret: '',
});

function linesToList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function sourceToDraft(row: WebhookSource): Draft {
  return {
    source: row.source,
    name: row.name,
    description: row.description ?? '',
    enabled: row.enabled,
    provider: (row.provider as LLMProvider) || 'claude',
    model: row.model ?? '',
    prompt: row.prompt || DEFAULT_PROMPT,
    permission_mode: row.permission_mode || 'bypassPermissions',
    mcp_tools_text: (row.mcp_tools ?? []).join('\n'),
    skills_text: (row.skills ?? []).join('\n'),
    scope: row.scope === 'project' ? 'project' : 'global',
    project_id: row.project_id ?? '',
    retryMax: row.retryMax?.toString() ?? '',
    retryBackoffSeconds: row.retryBackoffSeconds?.toString() ?? '',
    secret: row.secret ?? '',
  };
}

function draftToInput(draft: Draft): WebhookSourceInput {
  return {
    source: draft.source.trim(),
    name: draft.name.trim() || draft.source.trim(),
    description: draft.description,
    enabled: draft.enabled,
    provider: draft.provider,
    model: draft.model.trim() || null,
    prompt: draft.prompt,
    permission_mode: draft.permission_mode,
    mcp_tools: linesToList(draft.mcp_tools_text),
    skills: linesToList(draft.skills_text),
    scope: draft.scope,
    project_id: draft.scope === 'project' ? draft.project_id || null : null,
    retryMax:
      draft.retryMax === ''
        ? undefined
        : Math.min(10, Math.max(0, Math.round(Number(draft.retryMax) || 0))),
    retryBackoffSeconds:
      draft.retryBackoffSeconds === ''
        ? undefined
        : Math.max(1, Math.round(Number(draft.retryBackoffSeconds) || 60)),
    secret: draft.secret.trim() || null,
  };
}

function statusColor(status: string): string {
  switch (status) {
    case 'done':
      return 'text-emerald-600 dark:text-emerald-400';
    case 'failed':
      return 'text-red-600 dark:text-red-400';
    case 'running':
      return 'text-amber-600 dark:text-amber-400';
    default:
      return 'text-muted-foreground';
  }
}

function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const diff = then - Date.now();
  const mins = Math.round(Math.abs(diff) / 60000);
  if (mins < 1) return diff >= 0 ? 'in <1m' : 'just now';
  if (mins < 60) return diff >= 0 ? `in ${mins}m` : `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return diff >= 0 ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  return diff >= 0 ? `in ${days}d` : `${days}d ago`;
}

export default function WebhooksSettingsTab() {
  const [sources, setSources] = useState<WebhookSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [deliveriesLoading, setDeliveriesLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [replayingId, setReplayingId] = useState<string | null>(null);
  const [showSecret, setShowSecret] = useState(false);

  const ingestUrl = useMemo(() => {
    if (typeof window === 'undefined') return '/api/hooks';
    return `${window.location.origin}/api/hooks`;
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await webhooksApi.list();
      setSources(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDeliveries = useCallback(async (id: string) => {
    setDeliveriesLoading(true);
    try {
      const list = await webhooksApi.listDeliveries(id);
      setDeliveries(list);
    } catch {
      setDeliveries([]);
    } finally {
      setDeliveriesLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (selectedId) {
      void loadDeliveries(selectedId);
    } else {
      setDeliveries([]);
    }
  }, [selectedId, loadDeliveries]);

  const openCreate = () => {
    setEditingId(null);
    setDraft(emptyDraft());
    setShowForm(true);
  };

  const openEdit = (row: WebhookSource) => {
    setEditingId(row.source_id);
    setDraft(sourceToDraft(row));
    setShowForm(true);
    setSelectedId(row.source_id);
  };

  const handleSave = async () => {
    const input = draftToInput(draft);
    if (!input.source) {
      setError('Source slug is required (e.g. xspeech)');
      return;
    }
    if (!input.name) {
      setError('Name is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (editingId) {
        await webhooksApi.update(editingId, input);
      } else {
        await webhooksApi.create(input);
      }
      setShowForm(false);
      setEditingId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (row: WebhookSource) => {
    if (!window.confirm(`Delete webhook "${row.name}" (${row.source})?`)) return;
    try {
      await webhooksApi.remove(row.source_id);
      if (selectedId === row.source_id) setSelectedId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleToggle = async (row: WebhookSource) => {
    try {
      await webhooksApi.update(row.source_id, { enabled: !row.enabled });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleTest = async (row: WebhookSource) => {
    setTestingId(row.source_id);
    setError(null);
    try {
      await webhooksApi.test(row.source_id);
      setSelectedId(row.source_id);
      await loadDeliveries(row.source_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTestingId(null);
    }
  };

  const handleReplay = async (row: WebhookSource, deliveryId: string) => {
    setReplayingId(deliveryId);
    setError(null);
    try {
      await webhooksApi.replayDelivery(row.source_id, deliveryId);
      await loadDeliveries(row.source_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReplayingId(null);
    }
  };

  const curlExample = (sourceSlug: string) =>
    `curl -X POST "${ingestUrl}" \\\n  -H "x-api-key: ck_YOUR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"source":"${sourceSlug || 'xspeech'}","text":"Your note here","title":"Optional title"}'`;

  const copyCurl = async (sourceSlug: string) => {
    try {
      await navigator.clipboard.writeText(curlExample(sourceSlug));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <Webhook className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Webhooks</h2>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Receive external events (dictation, automations) and run a headless agent per{' '}
          <code className="rounded bg-muted px-1 text-xs">source</code>. Create an API token under
          API &amp; Tokens, then POST to{' '}
          <code className="rounded bg-muted px-1 text-xs">{ingestUrl}</code>.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {sources.length} source{sources.length === 1 ? '' : 's'}
        </p>
        <Button type="button" size="sm" onClick={openCreate}>
          <Plus className="mr-1 h-4 w-4" />
          Add source
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading…
        </div>
      ) : sources.length === 0 && !showForm ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          No webhook sources yet. Add one (e.g. <code>xspeech</code>) to start receiving notes.
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {sources.map((row) => (
            <li
              key={row.source_id}
              className={`flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between ${
                selectedId === row.source_id ? 'bg-accent/30' : ''
              }`}
            >
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => setSelectedId(row.source_id)}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{row.name}</span>
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{row.source}</code>
                  {!row.enabled && (
                    <span className="text-xs text-muted-foreground">(disabled)</span>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {AGENT_NAMES[row.provider as LLMProvider] || row.provider}
                  {row.model ? ` · ${row.model}` : ''}
                  {row.mcp_tools?.length ? ` · MCP: ${row.mcp_tools.join(', ')}` : ''}
                </p>
              </button>
              <div className="flex flex-shrink-0 flex-wrap items-center gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => void handleToggle(row)}
                  title={row.enabled ? 'Disable' : 'Enable'}
                >
                  {row.enabled ? 'On' : 'Off'}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => void handleTest(row)}
                  disabled={testingId === row.source_id || !row.enabled}
                  title="Send test delivery"
                >
                  {testingId === row.source_id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Play className="h-4 w-4" />
                  )}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => openEdit(row)}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => void handleDelete(row)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {showForm && (
        <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-4">
          <h3 className="text-sm font-semibold">{editingId ? 'Edit source' : 'New source'}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={labelClass}>Source slug *</label>
              <Input
                value={draft.source}
                onChange={(e) => setDraft((d) => ({ ...d, source: e.target.value }))}
                placeholder="xspeech"
                className="mt-1"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Callers send this as <code>source</code> in body/query.
              </p>
            </div>
            <div>
              <label className={labelClass}>Display name *</label>
              <Input
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                placeholder="XSpeech dictation"
                className="mt-1"
              />
            </div>
            <div className="sm:col-span-2">
              <label className={labelClass}>Description</label>
              <Input
                value={draft.description}
                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                className="mt-1"
              />
            </div>
            <div>
              <label className={labelClass}>Agent</label>
              <select
                className={`${selectClass} mt-1`}
                value={draft.provider}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, provider: e.target.value as LLMProvider }))
                }
              >
                {AGENT_PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {AGENT_NAMES[p]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass}>Model (optional)</label>
              <Input
                value={draft.model}
                onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
                placeholder="default"
                className="mt-1"
              />
            </div>
            <div>
              <label className={labelClass}>Permission mode</label>
              <select
                className={`${selectClass} mt-1`}
                value={draft.permission_mode}
                onChange={(e) => setDraft((d) => ({ ...d, permission_mode: e.target.value }))}
              >
                <option value="bypassPermissions">Bypass permissions (recommended)</option>
                <option value="acceptEdits">Accept edits</option>
                <option value="default">Default</option>
                <option value="plan">Plan</option>
              </select>
            </div>
            <div>
              <label className={labelClass}>Max retries (0-10)</label>
              <Input
                type="number"
                min={0}
                max={10}
                value={draft.retryMax}
                onChange={(e) => setDraft((d) => ({ ...d, retryMax: e.target.value }))}
                placeholder="0"
                className="mt-1"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Automatic re-dispatches after a failed run. 0 disables retries.
              </p>
            </div>
            <div>
              <label className={labelClass}>Retry backoff (seconds)</label>
              <Input
                type="number"
                min={1}
                value={draft.retryBackoffSeconds}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, retryBackoffSeconds: e.target.value }))
                }
                placeholder="60"
                className="mt-1"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Base delay; each retry waits backoff &times; attempt.
              </p>
            </div>
            <div className="sm:col-span-2">
              <label className={labelClass}>HMAC secret (optional)</label>
              <div className="mt-1 flex gap-2">
                <Input
                  type={showSecret ? 'text' : 'password'}
                  value={draft.secret}
                  onChange={(e) => setDraft((d) => ({ ...d, secret: e.target.value }))}
                  placeholder="leave blank to disable"
                  autoComplete="off"
                  className="flex-1"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setShowSecret((v) => !v)}
                >
                  {showSecret ? 'Hide' : 'Show'}
                </Button>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                When set, callers must sign the raw request body with HMAC-SHA256 using this
                secret and send it as <code>x-webhook-signature</code> (optionally{' '}
                <code>sha256=</code>-prefixed). Blank disables verification.
              </p>
            </div>
            <div>
              <label className={labelClass}>Scope</label>
              <select
                className={`${selectClass} mt-1`}
                value={draft.scope}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    scope: e.target.value === 'project' ? 'project' : 'global',
                  }))
                }
              >
                <option value="global">Global (home directory)</option>
                <option value="project">Project</option>
              </select>
            </div>
            {draft.scope === 'project' && (
              <div className="sm:col-span-2">
                <label className={labelClass}>Project ID</label>
                <Input
                  value={draft.project_id}
                  onChange={(e) => setDraft((d) => ({ ...d, project_id: e.target.value }))}
                  placeholder="project uuid"
                  className="mt-1"
                />
              </div>
            )}
            <div>
              <label className={labelClass}>MCP servers (one per line)</label>
              <textarea
                className={`${textareaClass} mt-1 min-h-[72px]`}
                value={draft.mcp_tools_text}
                onChange={(e) => setDraft((d) => ({ ...d, mcp_tools_text: e.target.value }))}
                placeholder="Obsidian"
              />
            </div>
            <div>
              <label className={labelClass}>Skills (optional, one per line)</label>
              <textarea
                className={`${textareaClass} mt-1 min-h-[72px]`}
                value={draft.skills_text}
                onChange={(e) => setDraft((d) => ({ ...d, skills_text: e.target.value }))}
                placeholder="project-memory"
              />
            </div>
            <div className="sm:col-span-2">
              <label className={labelClass}>Prompt template</label>
              <textarea
                className={`${textareaClass} mt-1 font-mono text-xs`}
                value={draft.prompt}
                onChange={(e) => setDraft((d) => ({ ...d, prompt: e.target.value }))}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Placeholders: {'{{text}}'}, {'{{payload}}'}, {'{{source}}'}, {'{{title}}'},{' '}
                {'{{timestamp}}'}, {'{{delivery_id}}'}
              </p>
            </div>
            <div className="flex items-center gap-2 sm:col-span-2">
              <input
                id="webhook-enabled"
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))}
              />
              <label htmlFor="webhook-enabled" className="text-sm">
                Enabled
              </label>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setShowForm(false);
                setEditingId(null);
              }}
            >
              Cancel
            </Button>
            <Button type="button" onClick={() => void handleSave()} disabled={saving}>
              {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              Save
            </Button>
          </div>
        </div>
      )}

      {selectedId && (
        <div className="space-y-3 rounded-lg border border-border p-4">
          {(() => {
            const row = sources.find((s) => s.source_id === selectedId);
            if (!row) return null;
            return (
              <>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold">Ingest for {row.source}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Auth: <code>x-api-key</code>, <code>Authorization: Bearer</code>, or{' '}
                      <code>?apiKey=</code>. Fields also accept query/headers.
                    </p>
                  </div>
                  <Button type="button" size="sm" variant="outline" onClick={() => void copyCurl(row.source)}>
                    {copied ? <Check className="mr-1 h-4 w-4" /> : <Copy className="mr-1 h-4 w-4" />}
                    Copy curl
                  </Button>
                </div>
                <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">{curlExample(row.source)}</pre>

                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-medium">Recent deliveries</h4>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => void loadDeliveries(row.source_id)}
                  >
                    Refresh
                  </Button>
                </div>
                {deliveriesLoading ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading deliveries…
                  </div>
                ) : deliveries.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No deliveries yet.</p>
                ) : (
                  <ul className="max-h-64 space-y-2 overflow-y-auto text-sm">
                    {deliveries.map((d) => (
                      <li key={d.delivery_id} className="rounded-md border border-border px-3 py-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`font-medium ${statusColor(d.status)}`}>{d.status}</span>
                          <span className="text-xs text-muted-foreground">
                            {new Date(d.created_at).toLocaleString()}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            attempt {(d.attempt ?? 1)}
                          </span>
                          {d.next_retry_at && (
                            <span className="text-xs text-muted-foreground">
                              retry {relativeTime(d.next_retry_at)}
                            </span>
                          )}
                          {d.app_session_id && (
                            <code className="text-xs text-muted-foreground">
                              session {d.app_session_id.slice(0, 8)}…
                            </code>
                          )}
                          {d.status === 'failed' && (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => void handleReplay(row, d.delivery_id)}
                              disabled={replayingId === d.delivery_id}
                              title="Re-run this delivery"
                            >
                              {replayingId === d.delivery_id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Play className="h-4 w-4" />
                              )}
                              Replay
                            </Button>
                          )}
                        </div>
                        {d.error_message && (
                          <p className="mt-1 text-xs text-red-600 dark:text-red-400">{d.error_message}</p>
                        )}
                        {d.result_preview && (
                          <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">
                            {d.result_preview}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}
