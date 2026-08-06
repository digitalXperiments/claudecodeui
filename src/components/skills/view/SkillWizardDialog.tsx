import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Globe, Loader2, Send, Sparkles } from 'lucide-react';

import type { LLMProvider } from '../../../types/app';
import { cn } from '../../../lib/utils';
import { useAgentVisibility } from '../../../hooks/useAgentVisibility';
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
} from '../../../shared/view/ui';
import ProviderBindingMatrix, { FANOUT_PROVIDERS, PROVIDER_LABELS } from '../../shared/view/ProviderBindingMatrix';
import { useProjectsOptions } from '../hooks/useProjectsOptions';
import { useGlobalSkills } from '../hooks/useGlobalSkills';
import { useProjectSkills } from '../hooks/useProjectSkills';
import { useSkillWizardSession } from '../hooks/useSkillWizardSession';
import { testSkill, type SkillTestResult } from '../api/skillTest';
import type { SkillWizardDraft } from '../lib/skillWizardPrompt';
import type { GlobalSkillScope } from '../types';

import SkillScopeField from './SkillScopeField';

export interface SkillWizardDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Flattened chat transcript, when launched from chat. */
  seedTranscript?: string;
  /** Provider id, e.g. 'claude'. */
  defaultProvider: string;
  /** Enables the "This project" save target. */
  projectPath?: string;
  defaultSaveTarget?: 'global' | 'project';
  onOpenInEditor?(draft: SkillWizardDraft): void;
  /** Lets parents refresh skill lists after a successful save. */
  onSaved?(): void;
}

type SaveTarget = 'global' | 'project';

type WizardToast = {
  message: string;
  tone: 'success' | 'error';
};

const normalizeDirectoryName = (value: string): string => (
  value
    .trim()
    .replace(/[\\/]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
);

const resolveProvider = (preferred: string, enabled: LLMProvider[]): string => (
  enabled.includes(preferred as LLMProvider)
    ? preferred
    : (enabled[0] ?? preferred)
);

const providerLabel = (provider: string): string => (
  PROVIDER_LABELS[provider as LLMProvider] ?? provider
);

/**
 * Conversational skill-authoring wizard: a live agent chat on the left, a
 * read-only SKILL.md preview on the right, and a save-target row (global
 * fan-out or project skill) above the footer actions.
 */
export default function SkillWizardDialog({
  open,
  onOpenChange,
  seedTranscript,
  defaultProvider,
  projectPath,
  defaultSaveTarget,
  onOpenInEditor,
  onSaved,
}: SkillWizardDialogProps) {
  const { t } = useTranslation('skills');
  const { enabledProviders } = useAgentVisibility();
  const { projects: projectOptions, isLoading: projectsLoading } = useProjectsOptions();
  const { addSkills: addGlobalSkills } = useGlobalSkills();
  const { addSkills: addProjectSkills } = useProjectSkills({ workspacePath: projectPath ?? null });
  const {
    messages,
    streaming,
    ready,
    draft,
    error,
    start,
    send,
    reset,
  } = useSkillWizardSession();

  const [provider, setProvider] = useState<string>(() => resolveProvider(defaultProvider, enabledProviders));
  const [saveTarget, setSaveTarget] = useState<SaveTarget>(defaultSaveTarget === 'project' && projectPath ? 'project' : 'global');
  const [scope, setScope] = useState<GlobalSkillScope>('all');
  const [selectedProjects, setSelectedProjects] = useState<string[]>([]);
  const [selectedProviders, setSelectedProviders] = useState<LLMProvider[]>(FANOUT_PROVIDERS);
  const [composerValue, setComposerValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<SkillTestResult | null>(null);
  const [toast, setToast] = useState<WizardToast | null>(null);
  const [previewFlash, setPreviewFlash] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const startRef = useRef(start);
  const resetRef = useRef(reset);

  useEffect(() => {
    startRef.current = start;
    resetRef.current = reset;
  });

  // Opening the dialog (re)starts the wizard session from scratch; closing
  // tears it down. Provider changes go through handleProviderChange below.
  useEffect(() => {
    if (!open) {
      resetRef.current();
      return;
    }

    const resolvedProvider = resolveProvider(defaultProvider, enabledProviders);
    setProvider(resolvedProvider);
    setSaveTarget(defaultSaveTarget === 'project' && projectPath ? 'project' : 'global');
    setScope('all');
    setSelectedProjects([]);
    setSelectedProviders(FANOUT_PROVIDERS);
    setComposerValue('');
    setSaving(false);
    setTesting(false);
    setTestResult(null);
    resetRef.current();
    void startRef.current({ provider: resolvedProvider, projectPath, transcript: seedTranscript });
  }, [open, defaultProvider, defaultSaveTarget, enabledProviders, projectPath, seedTranscript]);

  const handleProviderChange = useCallback((nextProvider: string) => {
    if (nextProvider === provider) {
      return;
    }
    setProvider(nextProvider);
    resetRef.current();
    void startRef.current({ provider: nextProvider, projectPath, transcript: seedTranscript });
  }, [provider, projectPath, seedTranscript]);

  // Text bubbles only — tool/status traffic stays out of the thread.
  const threadMessages = useMemo(() => (
    messages.filter((message) => (
      message.kind === 'text'
      && typeof message.content === 'string'
      && message.content.trim().length > 0
    ))
  ), [messages]);

  // Keep the chat pinned to the latest turn.
  useEffect(() => {
    const container = scrollRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [threadMessages.length, streaming]);

  // Brief highlight whenever the extracted draft changes.
  const lastDraftContentRef = useRef<string | null>(null);
  useEffect(() => {
    const nextContent = draft?.content ?? null;
    if (nextContent && nextContent !== lastDraftContentRef.current) {
      setPreviewFlash(true);
      const timer = window.setTimeout(() => setPreviewFlash(false), 700);
      lastDraftContentRef.current = nextContent;
      return () => window.clearTimeout(timer);
    }
    lastDraftContentRef.current = nextContent;
    return undefined;
  }, [draft]);

  const showToast = useCallback((message: string, tone: WizardToast['tone']) => {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    setToast({ message, tone });
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  useEffect(() => () => {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
  }, []);

  const handleSend = useCallback(() => {
    const text = composerValue.trim();
    if (!text || streaming || !ready) {
      return;
    }
    setComposerValue('');
    send(text);
  }, [composerValue, streaming, ready, send]);

  const canCreate = Boolean(draft)
    && !streaming
    && !saving
    && (saveTarget === 'project'
      ? Boolean(projectPath)
      : scope !== 'projects' || selectedProjects.length > 0);

  const handleCreate = useCallback(async () => {
    if (!draft || saving) {
      return;
    }

    setSaving(true);
    try {
      const directoryName = normalizeDirectoryName(draft.name);
      if (!directoryName) {
        throw new Error('The drafted skill is missing a name.');
      }

      if (saveTarget === 'project' && projectPath) {
        await addProjectSkills([{ content: draft.content, directoryName }]);
        showToast(t('wizard.createSuccess.project'), 'success');
      } else {
        await addGlobalSkills([{ content: draft.content, directoryName }], {
          scope,
          ...(scope === 'projects' ? { projects: selectedProjects } : {}),
          providers: selectedProviders,
        });
        showToast(t('wizard.createSuccess.global'), 'success');
      }

      onSaved?.();
      onOpenChange(false);
    } catch (createError) {
      showToast(createError instanceof Error ? createError.message : t('wizard.createError'), 'error');
    } finally {
      setSaving(false);
    }
  }, [draft, saving, saveTarget, projectPath, scope, selectedProjects, selectedProviders, addProjectSkills, addGlobalSkills, showToast, onSaved, onOpenChange, t]);

  const handleDryRun = useCallback(async () => {
    if (!draft || testing || streaming) {
      return;
    }

    setTesting(true);
    setTestResult(null);
    try {
      const workspacePath = saveTarget === 'project'
        ? projectPath
        : (scope === 'projects' ? selectedProjects[0] : projectPath);
      const result = await testSkill({
        content: draft.content,
        provider,
        workspacePath,
      }, saveTarget);
      setTestResult(result);
      if (result.success) {
        showToast(t('wizard.testSuccess', { defaultValue: 'Skill test finished.' }), 'success');
      } else {
        showToast(
          result.errorMessage || t('wizard.testFailure', { defaultValue: 'Skill test failed.' }),
          'error',
        );
      }
    } catch (testError) {
      showToast(testError instanceof Error ? testError.message : t('wizard.testFailure', { defaultValue: 'Skill test failed.' }), 'error');
    } finally {
      setTesting(false);
    }
  }, [draft, testing, streaming, provider, saveTarget, projectPath, scope, selectedProjects, showToast, t]);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          wrapperClassName="z-[10000]"
          className="flex h-[80vh] max-h-[820px] w-[calc(100vw-2rem)] max-w-[960px] flex-col overflow-hidden p-0"
        >
          <DialogTitle>{t('wizard.title')}</DialogTitle>

          <div className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-base font-medium text-foreground">
                <Sparkles className="h-4 w-4 shrink-0 text-primary" />
                {t('wizard.title')}
              </div>
              <div className="mt-0.5 truncate text-xs text-muted-foreground">{t('wizard.subtitle')}</div>
            </div>
            <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
              <span className="font-medium">{t('wizard.agent')}</span>
              <select
                value={provider}
                onChange={(event) => handleProviderChange(event.target.value)}
                className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"
              >
                {enabledProviders.map((providerOption) => (
                  <option key={providerOption} value={providerOption}>
                    {providerLabel(providerOption)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            {/* Left: conversation */}
            <div className="flex min-h-0 flex-1 flex-col md:w-[55%] md:flex-none md:border-r md:border-border/60">
              <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
                {threadMessages.map((message) => {
                  const isUser = message.role === 'user';
                  return (
                    <div key={message.id} className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
                      <div
                        className={cn(
                          'max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm leading-relaxed',
                          isUser
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-muted/60 text-foreground',
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
                  <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800/60 dark:bg-red-900/20 dark:text-red-200">
                    {error}
                  </div>
                )}
              </div>

              <div className="flex flex-shrink-0 items-end gap-2 border-t border-border/60 px-4 py-3">
                <textarea
                  value={composerValue}
                  onChange={(event) => setComposerValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      handleSend();
                    }
                  }}
                  placeholder={t('wizard.composerPlaceholder')}
                  rows={2}
                  className="max-h-32 min-h-[40px] flex-1 resize-y rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <Button
                  type="button"
                  size="sm"
                  className="shrink-0"
                  disabled={streaming || !ready || !composerValue.trim()}
                  onClick={handleSend}
                >
                  <Send className="h-4 w-4" />
                  {t('wizard.send')}
                </Button>
              </div>
            </div>

            {/* Right: live SKILL.md preview */}
            <div className="flex min-h-0 flex-1 flex-col md:w-[45%] md:flex-none">
              <div className="flex flex-shrink-0 items-center gap-2 border-b border-border/60 px-4 py-2.5 text-xs font-medium text-muted-foreground">
                {t('wizard.previewTitle')}
              </div>
              <div className="min-h-0 flex-1 overflow-hidden bg-zinc-950">
                {draft ? (
                  <pre
                    className={cn(
                      'h-full overflow-auto p-4 font-mono text-xs leading-relaxed text-zinc-200 transition-colors',
                      previewFlash && 'bg-primary/10',
                    )}
                  >
                    {draft.content}
                  </pre>
                ) : (
                  <div className="flex h-full items-center justify-center px-6 text-center text-sm text-zinc-500">
                    {t('wizard.previewEmpty')}
                  </div>
                )}
              </div>

              {testResult && (
                <div className="flex-shrink-0 border-t border-border/60 bg-background">
                  <div className="flex items-center justify-between gap-2 px-4 py-2 text-xs font-medium">
                    <span
                      className={cn(
                        'truncate',
                        testResult.success ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400',
                      )}
                    >
                      {testResult.success
                        ? t('wizard.testPassed', { defaultValue: 'Dry-run passed' })
                        : t('wizard.testFailed', { defaultValue: 'Dry-run failed' })}
                      <span className="ml-2 font-normal text-muted-foreground">
                        {testResult.durationMs} ms
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => setTestResult(null)}
                      className="shrink-0 text-muted-foreground hover:text-foreground"
                    >
                      {t('wizard.testClose', { defaultValue: 'Close' })}
                    </button>
                  </div>
                  <pre className="max-h-40 overflow-auto px-4 pb-3 font-mono text-xs leading-relaxed text-foreground">
                    {testResult.text.trim()
                      || testResult.errorMessage?.trim()
                      || t('wizard.testNoOutput', { defaultValue: 'No output' })}
                  </pre>
                </div>
              )}
            </div>
          </div>

          {/* Footer: save target + scope/provider fan-out + actions */}
          <div className="flex-shrink-0 border-t border-border/60">
            <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
              {projectPath && (
                <div className="inline-flex rounded-md border border-border bg-muted/20 p-0.5">
                  <button
                    type="button"
                    onClick={() => setSaveTarget('global')}
                    className={cn(
                      'flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition-colors',
                      saveTarget === 'global'
                        ? 'bg-background font-medium text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <Globe className="h-3.5 w-3.5" />
                    {t('wizard.saveTarget.global')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setSaveTarget('project')}
                    className={cn(
                      'flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition-colors',
                      saveTarget === 'project'
                        ? 'bg-background font-medium text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {t('wizard.saveTarget.project')}
                  </button>
                </div>
              )}
            </div>

            {saveTarget === 'global' && (
              <div className="grid max-h-48 gap-3 overflow-y-auto px-4 pt-3 sm:grid-cols-2">
                <SkillScopeField
                  scope={scope}
                  projects={selectedProjects}
                  options={projectOptions}
                  optionsLoading={projectsLoading}
                  onChange={(nextScope, nextProjects) => {
                    setScope(nextScope);
                    setSelectedProjects(nextProjects);
                  }}
                />
                <div>
                  <ProviderBindingMatrix
                    selected={selectedProviders}
                    onChange={setSelectedProviders}
                    providers={FANOUT_PROVIDERS}
                  />
                  <p className="mt-1.5 text-xs text-muted-foreground">{t('wizard.fanOutHint')}</p>
                </div>
              </div>
            )}

            <div className="flex flex-col-reverse gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-end">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full sm:w-auto"
                disabled={saving}
                onClick={() => onOpenChange(false)}
              >
                {t('wizard.cancel')}
              </Button>
              {onOpenInEditor && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full sm:w-auto"
                  disabled={!draft || saving}
                  onClick={() => draft && onOpenInEditor(draft)}
                >
                  {t('wizard.openInEditor')}
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full sm:w-auto"
                disabled={!draft || saving || testing || streaming}
                onClick={() => void handleDryRun()}
              >
                {testing && <Loader2 className="h-4 w-4 animate-spin" />}
                {testing ? t('wizard.testing', { defaultValue: 'Testing…' }) : t('wizard.testSkill', { defaultValue: 'Test skill' })}
              </Button>
              <Button
                type="button"
                size="sm"
                className="w-full sm:w-auto"
                disabled={!canCreate || testing}
                onClick={() => void handleCreate()}
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {saving ? t('wizard.creating') : t('wizard.createSkill')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {toast && (
        <div
          role="status"
          className={cn(
            'fixed bottom-6 left-1/2 z-[11000] -translate-x-1/2 rounded-full border px-4 py-2 text-sm font-medium shadow-lg',
            toast.tone === 'success'
              ? 'border-emerald-500/40 bg-emerald-600 text-white'
              : 'border-red-500/40 bg-red-600 text-white',
          )}
        >
          {toast.message}
        </div>
      )}
    </>
  );
}
