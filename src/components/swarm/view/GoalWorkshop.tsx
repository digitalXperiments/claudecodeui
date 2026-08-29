import { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Loader2,
  MessageSquareText,
  Send,
  Sparkles,
} from 'lucide-react';

import { authenticatedFetch } from '../../../utils/api';

type ChatTurn = { role: 'user' | 'assistant'; content: string };

function apiErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.error === 'string' && record.error.trim()) return record.error;
  if (typeof record.message === 'string' && record.message.trim()) return record.message;
  return null;
}

async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await authenticatedFetch(url, options);
  const payload = (await response.json().catch(() => null)) as T | null;
  if (!response.ok) {
    throw new Error(apiErrorMessage(payload) || `Request failed (${response.status})`);
  }
  return (payload ?? {}) as T;
}

export function GoalWorkshop({
  projectId,
  provider,
  model,
  currentGoal,
  onApplyGoal,
}: {
  projectId: string;
  provider: string;
  model: string | null;
  currentGoal: string;
  onApplyGoal: (goal: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [draft, setDraft] = useState('');
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readyGoal, setReadyGoal] = useState<string | null>(null);
  const activeRequest = useRef<AbortController | null>(null);

  useEffect(() => () => activeRequest.current?.abort(), []);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    if (!projectId) {
      setError('Select a project first so the coach can ground the contract.');
      return;
    }
    const nextTurns: ChatTurn[] = [...turns, { role: 'user', content: text }];
    setTurns(nextTurns);
    setDraft('');
    setBusy(true);
    setError(null);
    const controller = new AbortController();
    activeRequest.current?.abort();
    activeRequest.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 50_000);
    try {
      const payload = await requestJson<{
        reply?: string;
        draftGoal?: string | null;
        ready?: boolean;
      }>('/api/swarm/draft-goal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          provider,
          model,
          currentGoal,
          messages: nextTurns,
        }),
        signal: controller.signal,
      });
      const reply = (payload.reply || '').trim() || 'I need a bit more detail to write the contract.';
      setTurns([...nextTurns, { role: 'assistant', content: reply }]);
      if (payload.ready && payload.draftGoal?.trim()) {
        setReadyGoal(payload.draftGoal.trim());
      }
    } catch (caught) {
      setError(
        caught instanceof DOMException && caught.name === 'AbortError'
          ? 'The orchestrator did not answer in time. Try again, or switch the orchestrator model.'
          : caught instanceof Error
            ? caught.message
            : 'Goal workshop failed.',
      );
    } finally {
      window.clearTimeout(timeout);
      if (activeRequest.current === controller) activeRequest.current = null;
      setBusy(false);
    }
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/[0.08] via-card to-violet-500/[0.05] shadow-sm">
      <div className="flex items-start justify-between gap-3 px-4 py-3.5">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm shadow-primary/20">
            <MessageSquareText className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
              Goal architect
              <span className="rounded-full border border-primary/20 bg-background/70 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-primary">
                {provider}{model ? ` · ${model}` : ''}
              </span>
            </p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
              Shape a rough request into a bounded contract the swarm can execute and verify.
            </p>
          </div>
        </div>
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-border/50 bg-background/60 px-2 py-1 text-[10px] font-medium text-muted-foreground transition hover:bg-background hover:text-foreground"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          {open ? 'Collapse' : 'Open'}
        </button>
      </div>

      {open ? (
        <div className="space-y-3 border-t border-primary/10 bg-background/45 px-4 py-4">
          {turns.length > 0 ? (
            <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
              {turns.map((turn, index) => (
                <div
                  key={`${turn.role}-${index}`}
                  className={`max-w-[92%] whitespace-pre-wrap rounded-2xl px-3 py-2.5 text-xs leading-relaxed ${
                    turn.role === 'user'
                      ? 'ml-auto rounded-br-md bg-foreground text-background'
                      : 'rounded-bl-md border border-primary/15 bg-primary/[0.08] text-foreground'
                  }`}
                >
                  {turn.content}
                </div>
              ))}
            </div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-3">
              {['Define the outcome', 'Fence the scope', 'Write done-when checks'].map((label, index) => (
                <div key={label} className="rounded-xl border border-border/50 bg-background/70 px-3 py-2 text-[10px] text-muted-foreground">
                  <span className="mr-1.5 font-semibold text-primary">0{index + 1}</span>
                  {label}
                </div>
              ))}
            </div>
          )}

          <div className="rounded-2xl border border-border/70 bg-background p-2 shadow-sm transition focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/10">
            <textarea
              className="min-h-[72px] w-full resize-y bg-transparent px-1.5 py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground/70"
              placeholder={
                projectId
                  ? 'Describe the outcome, constraints, and anything the swarm must preserve…'
                  : 'Select a project, then describe the outcome…'
              }
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void send();
                }
              }}
              disabled={busy}
            />
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/40 px-1.5 pt-2">
              <p className="text-[9px] text-muted-foreground">⌘/Ctrl + Enter</p>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:opacity-50"
                onClick={() => void send()}
                disabled={busy || !draft.trim() || !projectId}
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : turns.length ? <Send className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
                {busy ? 'Thinking…' : turns.length ? 'Send' : 'Shape goal'}
              </button>
            </div>
          </div>
          {error ? (
            <p role="alert" className="rounded-xl border border-red-500/20 bg-red-500/[0.08] px-3 py-2 text-[11px] text-red-600 dark:text-red-300">
              {error}
            </p>
          ) : null}
          {readyGoal ? (
            <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.07] p-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 className="h-4 w-4" />
                Execution contract ready
              </div>
              <p className="mt-1.5 line-clamp-4 whitespace-pre-wrap text-[10px] leading-relaxed text-muted-foreground">
                {readyGoal}
              </p>
              <button
                type="button"
                className="mt-3 w-full rounded-xl bg-emerald-600 px-3 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-emerald-700"
                onClick={() => onApplyGoal(readyGoal)}
              >
                Use contract as swarm brief
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
