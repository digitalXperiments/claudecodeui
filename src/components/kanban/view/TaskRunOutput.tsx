import { useEffect, useRef } from 'react';
import { Loader2, Wrench } from 'lucide-react';

import { cn } from '../../../lib/utils';
import type { LLMProvider } from '../../../types/app';
import type { NormalizedMessage } from '../../../stores/useSessionStore';
import { useTaskSessionStream } from '../hooks/useTaskSessionStream';

type TaskRunOutputProps = {
  sessionId: string | null;
  isRunning: boolean;
  provider: LLMProvider;
};

function readText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'string'
          ? part
          : part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
            ? ((part as { text: string }).text)
            : '',
      )
      .join('');
  }
  if (content && typeof content === 'object') {
    return JSON.stringify(content);
  }
  return '';
}

function roleLabel(message: NormalizedMessage): string {
  if (message.kind === 'thinking') {
    return 'thinking';
  }
  if (message.kind === 'tool_use' || message.kind === 'tool_result') {
    return message.kind === 'tool_use' ? 'tool' : 'result';
  }
  const role = (message as { role?: unknown }).role;
  return typeof role === 'string' ? role : 'assistant';
}

/**
 * Live transcript for a task's run. Subscribes to the session stream (replays
 * buffered events, then streams live) and renders the merged messages. Falling
 * back to the persisted transcript when the run has already finished.
 */
export default function TaskRunOutput({ sessionId, isRunning, provider }: TaskRunOutputProps) {
  const messages = useTaskSessionStream(sessionId, provider);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  if (!sessionId) {
    return <p className="text-xs text-muted-foreground">No run yet. Click Run to start the agent.</p>;
  }

  const visible = messages.filter((message) => {
    const text = readText((message as { content?: unknown }).content).trim();
    return text.length > 0 || message.kind === 'tool_use';
  });

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>Output</span>
        {isRunning && <Loader2 className="h-3 w-3 animate-spin" />}
      </div>
      <div
        ref={scrollRef}
        className="max-h-64 overflow-y-auto rounded-md border border-border bg-muted/30 p-2 font-mono text-xs"
      >
        {visible.length === 0 ? (
          <p className="text-muted-foreground">{isRunning ? 'Waiting for output…' : 'No output yet.'}</p>
        ) : (
          visible.map((message, index) => {
            const role = roleLabel(message);
            const isTool = message.kind === 'tool_use' || message.kind === 'tool_result';
            const text = readText((message as { content?: unknown }).content).trim();
            const toolName = (message as { toolName?: unknown }).toolName;
            return (
              <div key={message.id ?? index} className="mb-2 whitespace-pre-wrap break-words">
                <span
                  className={cn(
                    'mr-1 inline-flex items-center gap-0.5 font-semibold',
                    role === 'user'
                      ? 'text-primary'
                      : isTool
                        ? 'text-amber-600 dark:text-amber-400'
                        : 'text-foreground',
                  )}
                >
                  {isTool && <Wrench className="h-3 w-3" />}
                  {typeof toolName === 'string' && toolName ? toolName : role}:
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
