import { ChevronUp, Loader2, MessageSquare, Send } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { Button } from '../../../../../shared/view/ui';
import type { McSection } from '../../../../mission-control/api/missionControlApi';
import { botRuntimeApi } from '../../../api/botRuntimeApi';
import { appendThreadMessage, prependThreadPage } from '../../../hooks/botRuntimeReducers';
import { useBotRuntime, useBotRuntimeStatus } from '../../../hooks/useBotRuntime';
import Skeleton from '../../../ui/Skeleton';

import ThreadBubble from './parts/ThreadBubble';
import {
  groupThreadByDay, makeOptimisticMessage, mergeOptimistic, oldestCursor, shouldSendOnKey, THREAD_PAGE_SIZE,
  type OptimisticMessage, type ThreadEntry,
} from './parts/thread';

const THREAD_SECTIONS = ['thread' as const];
const OLDER_PAGE = 50;
const MAX_LENGTH = 4000;
const NEAR_BOTTOM_PX = 120;

export function ThreadTab({ botId }: { botId: string; section: McSection }) {
  const runtime = useBotRuntime(botId, { sections: THREAD_SECTIONS });
  const { status } = useBotRuntimeStatus();
  const { patchSection } = runtime;
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<OptimisticMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [canLoadOlder, setCanLoadOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  const prependAnchor = useRef<number | null>(null);
  const initialised = useRef<string | null>(null);

  const messages = runtime.thread;
  const loadState = runtime.sectionState.thread.state;
  const entries: ThreadEntry[] = useMemo(() => mergeOptimistic(messages, pending), [messages, pending]);
  const groups = useMemo(() => groupThreadByDay(entries), [entries]);
  const botWorking = Boolean(status?.running.includes(botId));

  // A full first page hints that older history exists; decided once per bot when the thread first loads.
  useEffect(() => {
    if (loadState === 'ready' && initialised.current !== botId) {
      initialised.current = botId;
      setCanLoadOlder(messages.length >= THREAD_PAGE_SIZE);
    }
  }, [botId, loadState, messages.length]);

  useEffect(() => {
    setPending([]);
    setDraft('');
    setError(null);
    stickToBottom.current = true;
    initialised.current = null;
    setCanLoadOlder(false);
  }, [botId]);

  // Keep the newest message in view unless the operator scrolled up; keep position when older pages prepend.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    if (prependAnchor.current !== null) {
      node.scrollTop += node.scrollHeight - prependAnchor.current;
      prependAnchor.current = null;
      return;
    }
    if (stickToBottom.current) node.scrollTop = node.scrollHeight;
  }, [entries.length, botWorking]);

  const onScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < NEAR_BOTTOM_PX;
  };

  const loadOlder = useCallback(async () => {
    const before = oldestCursor(messages);
    if (!before || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await botRuntimeApi.thread.list(botId, { limit: OLDER_PAGE, before });
      prependAnchor.current = scrollRef.current?.scrollHeight ?? null;
      patchSection('thread', (current) => prependThreadPage(current, page));
      if (page.length < OLDER_PAGE) setCanLoadOlder(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load older messages.');
    } finally {
      setLoadingOlder(false);
    }
  }, [botId, loadingOlder, messages, patchSection]);

  const deliver = useCallback(async (optimistic: OptimisticMessage) => {
    setError(null);
    try {
      const sent = await botRuntimeApi.thread.send(botId, optimistic.body);
      // The websocket echo may already have added it; the append de-dupes by id.
      patchSection('thread', (current) => appendThreadMessage(current, sent));
      setPending((current) => current.filter((entry) => entry.message_id !== optimistic.message_id));
    } catch (caught) {
      setPending((current) => current.map((entry) => (entry.message_id === optimistic.message_id ? { ...entry, failed: true } : entry)));
      setError(caught instanceof Error ? caught.message : 'Unable to send the message.');
    }
  }, [botId, patchSection]);

  const send = () => {
    const body = draft.trim();
    if (!body) return;
    const optimistic = makeOptimisticMessage(botId, body, Date.now(), `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    stickToBottom.current = true;
    setPending((current) => [...current, optimistic]);
    setDraft('');
    void deliver(optimistic);
  };

  const retry = (entry: ThreadEntry) => {
    setPending((current) => current.map((item) => (item.message_id === entry.message_id ? { ...item, failed: false } : item)));
    const target = pending.find((item) => item.message_id === entry.message_id);
    if (target) void deliver({ ...target, failed: false });
  };
  const dismiss = (entry: ThreadEntry) => setPending((current) => current.filter((item) => item.message_id !== entry.message_id));

  const showEmpty = loadState === 'ready' && entries.length === 0;

  return (
    <div className="flex h-full min-h-[28rem] flex-col">
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6" role="log" aria-live="polite" aria-label="Conversation with this bot">
        {canLoadOlder ? (
          <div className="mb-3 flex justify-center">
            <Button size="sm" variant="ghost" onClick={() => void loadOlder()} disabled={loadingOlder}>
              {loadingOlder ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChevronUp className="h-3.5 w-3.5" />}Load older messages
            </Button>
          </div>
        ) : null}
        {(loadState === 'loading' || loadState === 'idle') && entries.length === 0 ? (
          <div className="space-y-3" aria-busy="true"><Skeleton className="h-10 w-2/3" /><Skeleton className="ml-auto h-10 w-1/2" /><Skeleton className="h-10 w-3/5" /></div>
        ) : null}
        {loadState === 'error' && entries.length === 0 ? <p role="alert" className="text-xs text-destructive">{runtime.error('thread') ?? 'Unable to load the conversation.'}</p> : null}
        {showEmpty ? (
          <div className="mx-auto mt-8 max-w-sm rounded-xl border border-dashed border-border p-6 text-center">
            <MessageSquare className="mx-auto h-5 w-5 text-muted-foreground" aria-hidden="true" />
            <p className="mt-2 text-sm font-medium">No messages yet</p>
            <p className="mt-1 text-xs text-muted-foreground">Write to this bot here. Every message wakes it, and its replies come back to this thread and to any channels you have configured (Telegram, Slack).</p>
          </div>
        ) : null}
        {groups.map((group) => (
          <section key={group.key} aria-label={group.label} className="mb-4">
            <h3 className="mb-3 text-center text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{group.label}</h3>
            <ul className="space-y-3">
              {group.entries.map((entry) => <ThreadBubble key={entry.message_id} entry={entry} onRetry={retry} onDismiss={dismiss} />)}
            </ul>
          </section>
        ))}
        {botWorking ? <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground" role="status"><Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />Bot is working…</p> : null}
      </div>

      <form
        className="shrink-0 border-t border-border/70 bg-background px-4 py-3 sm:px-6"
        onSubmit={(event) => { event.preventDefault(); send(); }}
      >
        {error ? <p role="alert" className="mb-2 text-xs text-destructive">{error}</p> : null}
        <div className="flex items-end gap-2">
          <label className="sr-only" htmlFor={`bot-thread-composer-${botId}`}>Message to the bot</label>
          <textarea
            id={`bot-thread-composer-${botId}`}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (shouldSendOnKey({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing }, draft)) {
                event.preventDefault();
                send();
              }
            }}
            maxLength={MAX_LENGTH}
            rows={2}
            placeholder="Message this bot…"
            className="max-h-40 min-h-11 w-full resize-y rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
          />
          <Button type="submit" size="icon" disabled={!draft.trim()} aria-label="Send message" title="Send (Enter)"><Send className="h-4 w-4" /></Button>
        </div>
        <p className="mt-1.5 text-[10px] text-muted-foreground">Enter to send · Shift+Enter for a new line</p>
      </form>
    </div>
  );
}

export default ThreadTab;
