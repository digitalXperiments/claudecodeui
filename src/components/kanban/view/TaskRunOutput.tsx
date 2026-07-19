import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { authenticatedFetch } from '../../../utils/api';
import { cn } from '../../../lib/utils';

type RawMessage = Record<string, unknown>;

type TaskRunOutputProps = {
  sessionId: string | null;
  isRunning: boolean;
};

function readText(message: RawMessage): string {
  const content = message.content ?? message.text ?? message.message;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (part && typeof part === 'object' && typeof (part as RawMessage).text === 'string') {
          return (part as RawMessage).text as string;
        }
        return '';
      })
      .join('');
  }
  if (content && typeof content === 'object') {
    return JSON.stringify(content);
  }
  return '';
}

function readRole(message: RawMessage): string {
  const role = message.role ?? message.type ?? message.kind;
  return typeof role === 'string' ? role : 'message';
}

/**
 * Lightweight transcript viewer for a task's run. Reads the session's provider
 * transcript over REST and polls while the run is active. (The richer live
 * stream via ChatMessagesPane + chat.subscribe can be layered on later.)
 */
export default function TaskRunOutput({ sessionId, isRunning }: TaskRunOutputProps) {
  const [messages, setMessages] = useState<RawMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    if (!sessionId) {
      setMessages([]);
      return;
    }
    setLoading(true);
    try {
      const res = await authenticatedFetch(
        `/api/providers/sessions/${sessionId}/messages?limit=200`,
      );
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload?.error?.message || 'Failed to load output');
      }
      const list = (payload?.data?.messages ?? payload?.messages ?? []) as RawMessage[];
      setMessages(Array.isArray(list) ? list : []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load output');
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll while the run is active so streamed output appears without a refresh.
  useEffect(() => {
    if (!isRunning || !sessionId) {
      return;
    }
    const timer = setInterval(() => {
      void load();
    }, 2000);
    return () => clearInterval(timer);
  }, [isRunning, sessionId, load]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  if (!sessionId) {
    return <p className="text-xs text-muted-foreground">No run yet. Click Run to start the agent.</p>;
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>Output</span>
        {(loading || isRunning) && <Loader2 className="h-3 w-3 animate-spin" />}
      </div>
      <div
        ref={scrollRef}
        className="max-h-56 overflow-y-auto rounded-md border border-border bg-muted/30 p-2 font-mono text-xs"
      >
        {error ? (
          <p className="text-destructive">{error}</p>
        ) : messages.length === 0 ? (
          <p className="text-muted-foreground">No output yet.</p>
        ) : (
          messages.map((message, index) => {
            const text = readText(message).trim();
            if (!text) {
              return null;
            }
            const role = readRole(message);
            return (
              <div key={index} className="mb-2 whitespace-pre-wrap">
                <span
                  className={cn(
                    'mr-1 font-semibold',
                    role === 'user' ? 'text-primary' : 'text-foreground',
                  )}
                >
                  {role}:
                </span>
                <span className="text-muted-foreground">{text}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
