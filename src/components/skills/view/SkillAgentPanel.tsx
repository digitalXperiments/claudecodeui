import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Send, Sparkles, X } from 'lucide-react';

import type { LLMProvider } from '../../../types/app';
import { cn } from '../../../lib/utils';
import { useAgentVisibility } from '../../../hooks/useAgentVisibility';
import { Button } from '../../../shared/view/ui';
import { PROVIDER_LABELS } from '../../shared/view/ProviderBindingMatrix';
import { useSkillWizardSession } from '../hooks/useSkillWizardSession';
import {
  buildEditBrief,
  stripEditorState,
  withEditorState,
  type SkillWizardDraft,
} from '../lib/skillWizardPrompt';

export interface SkillAgentPanelProps {
  /** Mounted-and-visible flag; flipping it on starts a fresh session. */
  open: boolean;
  onClose(): void;
  /** Agent cwd for the session gateway — required, or session creation 400s. */
  projectPath?: string;
  /** Directory/skill name, quoted in the brief for context. */
  skillName?: string;
  /**
   * Reads the editor buffer at send time. Must be stable across renders;
   * the panel calls it lazily so keystrokes don't restart anything.
   */
  getContent(): string;
  /** Fires whenever the agent emits a new full SKILL.md revision. */
  onDraft(draft: SkillWizardDraft): void;
}

const resolveProvider = (enabled: LLMProvider[]): string => enabled[0] ?? 'claude';

const providerLabel = (provider: string): string => (
  PROVIDER_LABELS[provider as LLMProvider] ?? provider
);

/**
 * Chat side panel for SkillEditorDialog: a scoped agent session briefed on the
 * SKILL.md currently in the editor. Each revision the agent emits is handed
 * back through `onDraft`, which the dialog drops straight into CodeMirror —
 * nothing touches disk until the user saves.
 */
export default function SkillAgentPanel({
  open,
  onClose,
  projectPath,
  skillName,
  getContent,
  onDraft,
}: SkillAgentPanelProps) {
  const { t } = useTranslation('skills');
  const { enabledProviders } = useAgentVisibility();
  const { messages, streaming, ready, draft, error, start, send, reset } = useSkillWizardSession();

  const [provider, setProvider] = useState<string>(() => resolveProvider(enabledProviders));
  const [composerValue, setComposerValue] = useState('');

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const startRef = useRef(start);
  const resetRef = useRef(reset);
  const getContentRef = useRef(getContent);
  const onDraftRef = useRef(onDraft);
  /**
   * The SKILL.md the agent last saw — its own revision, or the snapshot sent
   * with the brief. Hand edits made since then get re-pasted with the next
   * turn so the agent rebases instead of reverting them.
   */
  const agentContentRef = useRef('');

  useEffect(() => {
    startRef.current = start;
    resetRef.current = reset;
    getContentRef.current = getContent;
    onDraftRef.current = onDraft;
  });

  const beginSession = useCallback((nextProvider: string) => {
    const content = getContentRef.current();
    agentContentRef.current = content;
    resetRef.current();
    void startRef.current({
      provider: nextProvider,
      projectPath,
      brief: buildEditBrief({ skillName, content }),
    });
  }, [projectPath, skillName]);

  // Opening the panel starts a session seeded with the current buffer;
  // closing it tears the session down.
  useEffect(() => {
    if (!open) {
      resetRef.current();
      return;
    }
    const resolved = resolveProvider(enabledProviders);
    setProvider(resolved);
    setComposerValue('');
    beginSession(resolved);
  }, [open, enabledProviders, beginSession]);

  const handleProviderChange = useCallback((nextProvider: string) => {
    if (nextProvider === provider) {
      return;
    }
    setProvider(nextProvider);
    beginSession(nextProvider);
  }, [provider, beginSession]);

  // Push every new revision into the editor. Guarded on content so a
  // re-render with the same draft doesn't clobber edits made since.
  const lastAppliedRef = useRef<string | null>(null);
  useEffect(() => {
    const content = draft?.content;
    if (!content || content === lastAppliedRef.current) {
      return;
    }
    lastAppliedRef.current = content;
    agentContentRef.current = content;
    onDraftRef.current(draft as SkillWizardDraft);
  }, [draft]);

  // Text bubbles only — tool/status traffic stays out of the thread.
  const threadMessages = useMemo(() => (
    messages
      .filter((message) => (
        message.kind === 'text'
        && typeof message.content === 'string'
        && message.content.trim().length > 0
      ))
      .map((message) => ({
        ...message,
        content: message.role === 'user'
          ? stripEditorState(message.content as string)
          : (message.content as string),
      }))
      .filter((message) => message.content.trim().length > 0)
  ), [messages]);

  useEffect(() => {
    const container = scrollRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [threadMessages.length, streaming]);

  const handleSend = useCallback(() => {
    const text = composerValue.trim();
    if (!text || streaming || !ready) {
      return;
    }
    setComposerValue('');
    const content = getContentRef.current();
    const drifted = content.trim() !== agentContentRef.current.trim();
    agentContentRef.current = content;
    send(text, drifted ? withEditorState(text, content) : undefined);
  }, [composerValue, streaming, ready, send]);

  if (!open) {
    return null;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-border/60 md:w-[38%] md:flex-none md:border-l md:border-t-0">
      <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-foreground">
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span className="truncate">{t('editorChat.title', { defaultValue: 'Edit with agent' })}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <select
            value={provider}
            onChange={(event) => handleProviderChange(event.target.value)}
            className="h-7 rounded-md border border-border bg-background px-1.5 text-xs text-foreground"
          >
            {enabledProviders.map((providerOption) => (
              <option key={providerOption} value={providerOption}>
                {providerLabel(providerOption)}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:text-foreground"
            aria-label={t('editorChat.close', { defaultValue: 'Close agent chat' })}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-3">
        {!ready && !error && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('editorChat.starting', { defaultValue: 'Briefing the agent on this skill…' })}
          </div>
        )}

        {threadMessages.map((message) => {
          const isUser = message.role === 'user';
          return (
            <div key={message.id} className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
              <div
                className={cn(
                  'max-w-[90%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-xs leading-relaxed',
                  isUser ? 'bg-primary text-primary-foreground' : 'bg-muted/60 text-foreground',
                )}
              >
                {message.content}
              </div>
            </div>
          );
        })}

        {streaming && (
          <div className="flex justify-start">
            <div className="flex items-center gap-1.5 rounded-2xl bg-muted/60 px-3 py-2.5">
              <span className="sr-only">{t('wizard.typing')}</span>
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.3s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.15s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground" />
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800/60 dark:bg-red-900/20 dark:text-red-200">
            {error}
          </div>
        )}
      </div>

      <div className="flex flex-shrink-0 items-end gap-2 border-t border-border/60 px-3 py-2.5">
        <textarea
          value={composerValue}
          onChange={(event) => setComposerValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              handleSend();
            }
          }}
          placeholder={t('editorChat.composerPlaceholder', { defaultValue: 'Ask the agent to change this skill…' })}
          rows={2}
          className="max-h-28 min-h-[38px] flex-1 resize-y rounded-md border border-border bg-background px-2.5 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <Button
          type="button"
          size="sm"
          className="shrink-0"
          disabled={streaming || !ready || !composerValue.trim()}
          onClick={handleSend}
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex-shrink-0 border-t border-border/60 px-3 py-2 text-[11px] leading-snug text-muted-foreground">
        {t('editorChat.applyHint', {
          defaultValue: 'Revisions land in the editor automatically. Nothing is written until you save.',
        })}
      </div>
    </div>
  );
}
