import { useCallback, useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';

import { authenticatedFetch } from '../../../utils/api';
import { Button } from '../../../shared/view/ui';

export type SecretMetaOption = {
  secret_id: string;
  name: string;
  scope: string;
  description: string | null;
};

/**
 * Builds a `${secret:NAME}` reference. Prefer the bare name so scope resolution
 * follows the vault's project → provider → user cascade.
 */
export function secretRef(name: string): string {
  return `\${secret:${name}}`;
}

/**
 * Compact picker that inserts a vault secret reference into env/header fields.
 * Values never leave the vault — only the ref string is written into config.
 */
export default function SecretRefPicker({
  onPick,
  label = 'Use secret',
  className,
}: {
  onPick: (ref: string, secret: SecretMetaOption) => void;
  label?: string;
  className?: string;
}) {
  const [secrets, setSecrets] = useState<SecretMetaOption[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await authenticatedFetch('/api/secrets');
      if (!response.ok) {
        throw new Error(`Failed to load secrets (${response.status})`);
      }
      const payload = (await response.json()) as { secrets?: SecretMetaOption[] };
      setSecrets(payload.secrets ?? []);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not load secrets');
      setSecrets([]);
    }
  }, []);

  useEffect(() => {
    if (open) {
      void load();
    }
  }, [open, load]);

  return (
    <div className={className ?? 'relative inline-flex'}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 gap-1 px-2 text-[11px]"
        onClick={() => setOpen((value) => !value)}
        title="Insert a vault secret reference (${secret:NAME})"
      >
        <KeyRound className="h-3 w-3" />
        {label}
      </Button>
      {open ? (
        <div className="absolute right-0 top-full z-50 mt-1 w-64 rounded-md border border-border bg-popover p-1 shadow-lg">
          {error ? (
            <p className="px-2 py-1.5 text-[11px] text-destructive">{error}</p>
          ) : secrets.length === 0 ? (
            <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
              No secrets yet. Create one under Settings → Secrets.
            </p>
          ) : (
            <ul className="max-h-48 overflow-y-auto">
              {secrets.map((secret) => (
                <li key={secret.secret_id}>
                  <button
                    type="button"
                    className="flex w-full flex-col items-start rounded px-2 py-1.5 text-left hover:bg-accent"
                    onClick={() => {
                      onPick(secretRef(secret.name), secret);
                      setOpen(false);
                    }}
                  >
                    <span className="text-xs font-medium text-foreground">{secret.name}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {secret.scope}
                      {secret.description ? ` · ${secret.description}` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="border-t border-border/60 px-2 py-1.5 text-[10px] text-muted-foreground">
            Inserts <code className="text-[10px]">{'${secret:NAME}'}</code> — value stays in the vault.
          </p>
        </div>
      ) : null}
    </div>
  );
}
