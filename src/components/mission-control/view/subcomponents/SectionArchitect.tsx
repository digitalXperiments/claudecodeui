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

import {
  missionControlApi,
  type McSectionWorkshopDraft,
  type McSectionWorkshopMessage,
} from '../../api/missionControlApi';

export default function SectionArchitect({
  provider,
  model,
  projectId,
  projectName,
  currentDraft,
  availableMcpServers,
  onApply,
}: {
  provider: string;
  model: string | null;
  projectId: string | null;
  projectName: string | null;
  currentDraft: Partial<McSectionWorkshopDraft>;
  availableMcpServers: string[];
  onApply: (draft: McSectionWorkshopDraft) => void;
}) {
  const [open, setOpen] = useState(true);
  const [draft, setDraft] = useState('');
  const [turns, setTurns] = useState<McSectionWorkshopMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readyDraft, setReadyDraft] = useState<McSectionWorkshopDraft | null>(null);
  const activeRequest = useRef<AbortController | null>(null);

  useEffect(() => () => activeRequest.current?.abort(), []);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    const nextTurns: McSectionWorkshopMessage[] = [...turns, { role: 'user', content: text }];
    setTurns(nextTurns);
    setDraft('');
    setBusy(true);
    setError(null);
    setReadyDraft(null);
    const controller = new AbortController();
    activeRequest.current?.abort();
    activeRequest.current = controller;
    try {
      const payload = await missionControlApi.draftSection({
        provider,
        model,
        projectId,
        projectName,
        messages: nextTurns,
        currentDraft,
        availableMcpServers,
      });
      const reply = payload.reply.trim() || 'Tell me a little more about the workflow.';
      setTurns([...nextTurns, { role: 'assistant', content: reply }]);
      if (payload.ready && payload.draft) setReadyDraft(payload.draft);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Section architect failed.');
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null;
      setBusy(false);
    }
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/[0.09] via-card to-violet-500/[0.06] shadow-sm">
      <div className="flex items-start justify-between gap-3 px-4 py-3.5">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-violet-600 text-primary-foreground shadow-sm shadow-primary/20">
            <MessageSquareText className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
              Section architect
              <span className="rounded-full border border-primary/20 bg-background/70 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-primary">
                {provider}{model ? ` · ${model}` : ''}
              </span>
            </p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
              Describe a recurring workflow. The architect will shape the prompts, cadence, review gate, and handoff.
            </p>
          </div>
        </div>
        <button
          type="button"
          className="mc-tap-target inline-flex min-h-11 shrink-0 touch-manipulation items-center gap-1 rounded-lg border border-border/50 bg-background/60 px-3 py-2 text-[10px] font-medium text-muted-foreground transition hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
            <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
              {turns.map((turn, index) => (
                <div
                  key={`${turn.role}-${index}`}
                  className={`max-w-[94%] whitespace-pre-wrap rounded-2xl px-3 py-2.5 text-xs leading-relaxed ${
                    turn.role === 'user'
                      ? 'ml-auto rounded-br-md bg-foreground text-background'
                      : 'rounded-bl-md border border-primary/15 bg-primary/[0.08] text-foreground'
                  }`}
                >
                  {turn.content.replace(/```mission-section[\s\S]*?```/i, '').trim()}
                </div>
              ))}
            </div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-3">
              {['What should it watch?', 'What should it produce?', 'Who approves the result?'].map((label, index) => (
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
              placeholder="Example: Every weekday, collect customer feedback from Slack, draft prioritized action items, then create approved engineering work on Kanban…"
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
                className="mc-tap-target inline-flex min-h-11 touch-manipulation items-center gap-1.5 rounded-xl bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                onClick={() => void send()}
                disabled={busy || !draft.trim()}
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : turns.length ? <Send className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
                {busy ? 'Designing…' : turns.length ? 'Send' : 'Shape section'}
              </button>
            </div>
          </div>

          {error ? (
            <p role="alert" className="rounded-xl border border-red-500/20 bg-red-500/[0.08] px-3 py-2 text-[11px] text-red-600 dark:text-red-300">
              {error}
            </p>
          ) : null}

          {readyDraft ? (
            <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.07] p-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 className="h-4 w-4" />
                Section plan ready
              </div>
              <p className="mt-1.5 text-[11px] font-medium text-foreground">{readyDraft.title}</p>
              <p className="mt-0.5 line-clamp-3 text-[10px] leading-relaxed text-muted-foreground">
                {readyDraft.producePrompt}
              </p>
              <button
                type="button"
                className="mc-tap-target mt-3 min-h-11 w-full touch-manipulation rounded-xl bg-emerald-600 px-3 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onApply(readyDraft)}
              >
                Apply plan to section
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
