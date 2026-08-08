import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Plus, Trash2 } from 'lucide-react';

import { authenticatedFetch } from '../../../../utils/api';
import { Button } from '../../../../shared/view/ui/Button';
import { Input } from '../../../../shared/view/ui/Input';

type SecretMeta = {
  secret_id: string;
  name: string;
  scope: string;
  scope_ref: string | null;
  backend: string;
  content_type: string | null;
  description: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Settings → Secrets (PRD §8.6). Lists metadata only; values are write-only.
 */
export default function SecretsSettingsTab() {
  const [secrets, setSecrets] = useState<SecretMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await authenticatedFetch('/api/secrets');
      if (!response.ok) {
        throw new Error(`Failed to load secrets (${response.status})`);
      }
      const payload = (await response.json()) as { secrets?: SecretMeta[] };
      setSecrets(payload.secrets ?? []);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to load secrets');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleCreate = async () => {
    if (!name.trim() || !value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const response = await authenticatedFetch('/api/secrets', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          value,
          scope: 'user',
          description: description.trim() || undefined,
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Save failed (${response.status})`);
      }
      setName('');
      setValue('');
      setDescription('');
      setShowForm(false);
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to save secret');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (secretId: string) => {
    if (!window.confirm('Delete this secret? References will stop resolving.')) return;
    setBusy(true);
    try {
      const response = await authenticatedFetch(`/api/secrets/${encodeURIComponent(secretId)}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        throw new Error(`Delete failed (${response.status})`);
      }
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to delete secret');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <div className="text-sm text-muted-foreground">Loading secrets…</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
          <KeyRound className="h-4 w-4" />
          Secrets vault
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Store tokens once, then reference them as{' '}
          <code className="text-[10px]">$&#123;secret:NAME&#125;</code> in MCP env/headers,
          automations, and other integrations. Values are never shown after save and stay encrypted at rest.
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{secrets.length} secret(s)</span>
        <Button size="sm" variant="outline" onClick={() => setShowForm((v) => !v)} disabled={busy}>
          <Plus className="mr-1 h-3.5 w-3.5" />
          {showForm ? 'Cancel' : 'Add secret'}
        </Button>
      </div>

      {showForm ? (
        <div className="space-y-3 rounded-lg border border-border bg-card p-4">
          <div>
            <label className="text-xs font-medium text-foreground">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="GITHUB_TOKEN"
              className="mt-1"
              autoComplete="off"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-foreground">Value</label>
            <Input
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Paste secret once — it will not be shown again"
              className="mt-1"
              autoComplete="new-password"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-foreground">Description (optional)</label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Used for GitHub ship loop"
              className="mt-1"
            />
          </div>
          <Button size="sm" onClick={() => void handleCreate()} disabled={busy || !name.trim() || !value.trim()}>
            Save secret
          </Button>
        </div>
      ) : null}

      <ul className="divide-y divide-border rounded-lg border border-border">
        {secrets.length === 0 ? (
          <li className="px-4 py-6 text-center text-xs text-muted-foreground">
            No secrets yet. Add one to reference from MCP env, webhooks, or ship config.
          </li>
        ) : (
          secrets.map((secret) => (
            <li key={secret.secret_id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-foreground">{secret.name}</div>
                <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
                  <span>{secret.scope}</span>
                  <span>{secret.backend}</span>
                  <span className="font-mono text-[10px] opacity-70">{secret.secret_id.slice(0, 16)}…</span>
                  {secret.description ? <span className="truncate">{secret.description}</span> : null}
                </div>
              </div>
              <Button
                size="icon"
                variant="ghost"
                className="shrink-0 text-destructive"
                onClick={() => void handleDelete(secret.secret_id)}
                disabled={busy}
                aria-label={`Delete ${secret.name}`}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
