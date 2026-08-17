import { useMemo, useState } from 'react';
import { Loader2, MessagesSquare, Send } from 'lucide-react';

import type { ProjectSession, LLMProvider } from '../../../../types/app';

const MAX_DELEGATED_REQUEST_CHARS = 4000;

type SessionCollaborationControlProps = {
  currentSessionId: string | null;
  sessions: ProjectSession[];
  onStart: (request: {
    sessionId: string;
    provider: LLMProvider;
    prompt: string;
  }) => Promise<void> | void;
};

const getSessionProvider = (session: ProjectSession): LLMProvider => {
  const provider = session.__provider || session.provider;
  return typeof provider === 'string' && provider.trim() ? provider as LLMProvider : 'claude';
};

const getSessionLabel = (session: ProjectSession): string => {
  const label = session.summary || session.name || session.title;
  return typeof label === 'string' && label.trim() ? label.trim() : `Session ${session.id.slice(0, 8)}`;
};

/**
 * Starts an explicit, one-way delegation to an existing session. The source
 * chat stays mounted; the target receives the request through the normal
 * chat.send path and can be opened from the confirmation notice.
 */
export default function SessionCollaborationControl({
  currentSessionId,
  sessions,
  onStart,
}: SessionCollaborationControlProps) {
  const [open, setOpen] = useState(false);
  const [targetSessionId, setTargetSessionId] = useState('');
  const [request, setRequest] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const availableSessions = useMemo(
    () => sessions
      .filter((session) => session.id !== currentSessionId)
      .sort((a, b) => String(b.lastActivity || b.updated_at || '').localeCompare(String(a.lastActivity || a.updated_at || ''))),
    [currentSessionId, sessions],
  );

  const selectedSession = availableSessions.find((session) => session.id === targetSessionId) || null;

  const close = () => {
    if (busy) return;
    setOpen(false);
    setError(null);
  };

  const submit = async () => {
    if (!selectedSession) {
      setError('Choose a session first.');
      return;
    }

    const task = request.trim();
    if (!task) {
      setError('Describe what the other session should do.');
      return;
    }
    if (task.length > MAX_DELEGATED_REQUEST_CHARS) {
      setError(`Keep the request under ${MAX_DELEGATED_REQUEST_CHARS.toLocaleString()} characters.`);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await onStart({
        sessionId: selectedSession.id,
        provider: getSessionProvider(selectedSession),
        prompt: [
          'You are receiving a delegated request from another CloudCLI session.',
          'Work in your own session and return a concise result for the requesting session. Do not assume the requesting session can see your hidden reasoning or tool output.',
          '',
          `Delegated task:\n${task}`,
        ].join('\n'),
      });
      setRequest('');
      setTargetSessionId('');
      setOpen(false);
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : 'Could not contact that session.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        disabled={busy || availableSessions.length === 0}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-1 rounded-lg border border-border bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted/70 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        title={availableSessions.length === 0 ? 'No other sessions in this project' : 'Send a request to another session'}
      >
        <MessagesSquare className="h-3 w-3" />
        Ask another session
      </button>

      {open ? (
        <div className="absolute bottom-full left-0 z-30 mb-1 w-[min(22rem,calc(100vw-1.5rem))] rounded-lg border border-border bg-popover p-3 shadow-lg">
          <div className="mb-2">
            <p className="text-xs font-medium text-foreground">Delegate to an existing session</p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">The current session stays here. The other session runs the request in its own context.</p>
          </div>

          <label className="mb-1 block text-[10px] font-medium text-muted-foreground" htmlFor="session-collaboration-target">
            Target session
          </label>
          <select
            id="session-collaboration-target"
            value={targetSessionId}
            onChange={(event) => setTargetSessionId(event.target.value)}
            disabled={busy}
            className="mb-2 w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="">Choose a session…</option>
            {availableSessions.map((session) => (
              <option key={session.id} value={session.id}>
                {getSessionLabel(session)} · {getSessionProvider(session)}
              </option>
            ))}
          </select>

          <label className="mb-1 block text-[10px] font-medium text-muted-foreground" htmlFor="session-collaboration-request">
            Request
          </label>
          <textarea
            id="session-collaboration-request"
            value={request}
            onChange={(event) => setRequest(event.target.value)}
            disabled={busy}
            rows={3}
            maxLength={MAX_DELEGATED_REQUEST_CHARS}
            placeholder="Review the auth changes and report any risks…"
            className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus:ring-1 focus:ring-ring"
          />

          {error ? <p className="mt-1 text-[10px] text-red-500">{error}</p> : null}

          <div className="mt-2 flex justify-end gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={close}
              className="rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void submit()}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
              Send request
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
