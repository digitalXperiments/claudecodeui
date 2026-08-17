import { useState } from 'react';
import { MessagesSquare } from 'lucide-react';

import { createSessionSecondOpinion } from '../../../../utils/api';
import type { LLMProvider } from '../../../../types/app';

const PROVIDERS: Array<{ id: LLMProvider; label: string }> = [
  { id: 'codex', label: 'Codex' },
  { id: 'grok', label: 'Grok' },
  { id: 'claude', label: 'Claude' },
  { id: 'cursor', label: 'Cursor' },
];

type SecondOpinionControlProps = {
  sessionId: string | null;
  currentProvider: LLMProvider;
  onStart: (request: {
    sessionId: string;
    provider: LLMProvider;
    prompt: string;
  }) => void;
};

export default function SecondOpinionControl({
  sessionId,
  currentProvider,
  onStart,
}: SecondOpinionControlProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!sessionId) return null;

  const ask = async (targetProvider: LLMProvider) => {
    setBusy(true);
    setError(null);
    try {
      const data = await createSessionSecondOpinion(sessionId, { targetProvider }) as {
        sessionId?: string;
        provider?: string;
        handoffPrompt?: string | null;
      };
      const nextId = data.sessionId;
      const prompt = data.handoffPrompt?.trim();
      if (!nextId || !prompt) {
        throw new Error('Second opinion did not return a session.');
      }
      onStart({
        sessionId: nextId,
        provider: (data.provider || targetProvider) as LLMProvider,
        prompt,
      });
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Second opinion failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-1 rounded-lg border border-border bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted/70 hover:text-foreground disabled:opacity-50"
        title="Ask another provider without leaving this thread"
      >
        <MessagesSquare className="h-3 w-3" />
        Second opinion
      </button>
      {open ? (
        <div className="absolute bottom-full left-0 z-30 mb-1 w-48 rounded-lg border border-border bg-popover p-1.5 shadow-lg">
          <p className="px-1.5 pb-1 text-[10px] text-muted-foreground">
            Same files + last turns. You stay here.
          </p>
          {PROVIDERS.filter((row) => row.id !== currentProvider).map((row) => (
            <button
              key={row.id}
              type="button"
              disabled={busy}
              onClick={() => void ask(row.id)}
              className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
            >
              {row.label}
            </button>
          ))}
          {error ? <p className="px-1.5 pt-1 text-[10px] text-red-500">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
