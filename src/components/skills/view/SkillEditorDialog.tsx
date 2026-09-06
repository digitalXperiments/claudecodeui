import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { BrainCircuit, Loader2, Save, Sparkles } from 'lucide-react';

import type { LLMProvider } from '../../../types/app';
import { useTheme } from '../../../contexts/ThemeContext';
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Input,
} from '../../../shared/view/ui';
import { cn } from '../../../lib/utils';
import ProviderBindingMatrix, { FANOUT_PROVIDERS } from '../../shared/view/ProviderBindingMatrix';
import { useProjectsOptions } from '../hooks/useProjectsOptions';
import { splitSkillMarkdown, type SkillWizardDraft } from '../lib/skillWizardPrompt';
import type { GlobalSkillScope, ProviderSkillCreateEntryPayload } from '../types';

import SkillAgentPanel from './SkillAgentPanel';
import SkillScopeField from './SkillScopeField';

type EditableSkillRef = {
  directoryName: string;
  name: string;
  kind?: 'memory-template';
};

type SkillEditorDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'create' | 'edit';
  skill: EditableSkillRef | null;
  loadContent: (directoryName: string) => Promise<{ content: string }>;
  saveContent: (directoryName: string, content: string) => Promise<unknown>;
  createSkill: (
    entries: ProviderSkillCreateEntryPayload[],
    options?: { scope?: GlobalSkillScope; projects?: string[]; providers?: string[] },
  ) => Promise<unknown>;
  /** Show the "All projects / Selected projects" scope picker in create mode. */
  allowScopeSelection?: boolean;
  /** Initial scope when opening create mode with allowScopeSelection. */
  defaultScope?: GlobalSkillScope;
  /** Initial project paths when defaultScope is `projects`. */
  defaultProjects?: string[];
  /** Show provider fan-out matrix (CloudCLI catalog skills). */
  allowProviderSelection?: boolean;
  /**
   * Create mode only: prefill name/description/body instead of the skeleton
   * (e.g. a draft handed off from the skill wizard).
   */
  initialDraft?: { name: string; description: string; body: string };
  /** Hide the "Edit with agent" chat panel (defaults to shown). */
  disableAgentChat?: boolean;
  /**
   * Agent cwd for the chat panel's session. Falls back to the first known
   * project — the session gateway rejects a session without one.
   */
  agentProjectPath?: string;
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

const CREATE_BODY_SKELETON = `# Skill name

Describe what the agent should do, when to use this skill, and any
conventions or constraints it must follow.
`;

const buildCreateContent = (name: string, description: string, body: string): string => [
  '---',
  `name: ${name}`,
  `description: ${description.replace(/\s+/g, ' ').trim() || 'No description provided.'}`,
  '---',
  '',
  body.trim(),
  '',
].join('\n');

/**
 * Shared skill markdown editor used by both the Project Skills and Global
 * Skills tabs. `create` mode builds a valid SKILL.md from name + description +
 * body; `edit` mode loads and rewrites an existing managed skill in place.
 */
export default function SkillEditorDialog({
  open,
  onOpenChange,
  mode,
  skill,
  loadContent,
  saveContent,
  createSkill,
  allowScopeSelection = false,
  defaultScope = 'all',
  defaultProjects,
  allowProviderSelection = false,
  initialDraft,
  disableAgentChat = false,
  agentProjectPath,
}: SkillEditorDialogProps) {
  const { isDarkMode } = useTheme();
  const { projects: projectOptions, isLoading: projectsLoading } = useProjectsOptions();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [scope, setScope] = useState<GlobalSkillScope>('all');
  const [selectedProjects, setSelectedProjects] = useState<string[]>([]);
  const [selectedProviders, setSelectedProviders] = useState<LLMProvider[]>(['claude']);
  const [isLoadingContent, setIsLoadingContent] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isAgentChatOpen, setIsAgentChatOpen] = useState(false);
  const [agentFlash, setAgentFlash] = useState(false);

  // (Re)initialize state whenever the dialog is opened for a skill/mode.
  useEffect(() => {
    if (!open) {
      return;
    }

    setError(null);
    setIsSaving(false);
    setIsAgentChatOpen(false);
    if (mode === 'create') {
      setName(initialDraft?.name ?? '');
      setDescription(initialDraft?.description ?? '');
      setContent(initialDraft?.body ?? CREATE_BODY_SKELETON);
      setOriginalContent('');
      setScope(allowScopeSelection ? defaultScope : 'all');
      setSelectedProjects(allowScopeSelection && defaultScope === 'projects' ? (defaultProjects ?? []) : []);
      setIsLoadingContent(false);
      return;
    }

    if (!skill) {
      return;
    }

    setIsLoadingContent(true);
    setContent('');
    setOriginalContent('');
    setScope('all');
    setSelectedProjects([]);
    let cancelled = false;
    loadContent(skill.directoryName)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setContent(result.content);
        setOriginalContent(result.content);
      })
      .catch((loadError) => {
        if (cancelled) {
          return;
        }
        setError(loadError instanceof Error ? loadError.message : 'Failed to load skill content');
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingContent(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open, mode, skill, loadContent, initialDraft?.name, initialDraft?.description, initialDraft?.body, allowScopeSelection, defaultScope, defaultProjects]);

  const isDirty = useMemo(() => {
    if (mode === 'create') {
      return name.trim() !== (initialDraft?.name ?? '').trim()
        || content !== (initialDraft?.body ?? CREATE_BODY_SKELETON)
        || scope !== (allowScopeSelection ? defaultScope : 'all')
        || selectedProjects.join('\0') !== (allowScopeSelection && defaultScope === 'projects' ? (defaultProjects ?? []).join('\0') : '');
    }
    return content !== originalContent;
  }, [mode, name, content, originalContent, scope, selectedProjects, initialDraft?.name, initialDraft?.body, allowScopeSelection, defaultScope, defaultProjects]);

  const canCreate = useMemo(() => {
    if (mode !== 'create') {
      return true;
    }
    if (!name.trim()) {
      return false;
    }
    if (allowScopeSelection && scope === 'projects' && selectedProjects.length === 0) {
      return false;
    }
    return true;
  }, [mode, name, allowScopeSelection, scope, selectedProjects]);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (!nextOpen && isDirty && !window.confirm('Discard unsaved changes?')) {
      return;
    }
    onOpenChange(nextOpen);
  }, [isDirty, onOpenChange]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    setError(null);

    try {
      if (mode === 'create') {
        const directoryName = normalizeDirectoryName(name);
        if (!directoryName) {
          throw new Error('Enter a skill name first.');
        }
        const options: {
          scope?: GlobalSkillScope;
          projects?: string[];
          providers?: string[];
        } = {};
        if (allowScopeSelection) {
          options.scope = scope;
          if (scope === 'projects') {
            options.projects = selectedProjects;
          }
        }
        if (allowProviderSelection) {
          options.providers = selectedProviders;
        }
        await createSkill([{
          content: buildCreateContent(directoryName, description, content),
          directoryName,
        }], Object.keys(options).length > 0 ? options : undefined);
      } else if (skill) {
        await saveContent(skill.directoryName, content.trim());
      }
      onOpenChange(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save skill');
    } finally {
      setIsSaving(false);
    }
  }, [mode, name, description, content, skill, allowScopeSelection, allowProviderSelection, scope, selectedProjects, selectedProviders, createSkill, saveContent, onOpenChange]);

  // The chat panel reads the buffer lazily at send time; in create mode the
  // editor holds only the body, so the agent always sees a whole SKILL.md.
  const contentRef = useRef(content);
  const nameRef = useRef(name);
  const descriptionRef = useRef(description);
  useEffect(() => {
    contentRef.current = content;
    nameRef.current = name;
    descriptionRef.current = description;
  });

  const getAgentContent = useCallback(() => (
    mode === 'create'
      ? buildCreateContent(normalizeDirectoryName(nameRef.current) || 'new-skill', descriptionRef.current, contentRef.current)
      : contentRef.current
  ), [mode]);

  // Auto-apply: an agent revision replaces the buffer outright. Nothing hits
  // disk until Save, so an unwanted rewrite is one Cancel away.
  const handleAgentDraft = useCallback((draft: SkillWizardDraft) => {
    if (mode === 'create') {
      const split = splitSkillMarkdown(draft.content);
      setName(split.name || draft.name);
      setDescription(split.description || draft.description);
      setContent(split.body);
    } else {
      setContent(draft.content);
    }
    setAgentFlash(true);
  }, [mode]);

  useEffect(() => {
    if (!agentFlash) {
      return undefined;
    }
    const timer = window.setTimeout(() => setAgentFlash(false), 700);
    return () => window.clearTimeout(timer);
  }, [agentFlash]);

  const agentSessionPath = agentProjectPath ?? projectOptions[0]?.fullPath;
  const canUseAgentChat = !disableAgentChat && Boolean(agentSessionPath);

  const isMemoryTemplate = skill?.kind === 'memory-template';
  const title = mode === 'create'
    ? 'New Skill'
    : `Edit ${isMemoryTemplate ? 'Memory Skill Template' : (skill?.name ?? 'Skill')}`;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        wrapperClassName="z-[10100]"
        className={cn(
          'flex h-[calc(100vh-2rem)] max-h-[760px] w-[calc(100vw-2rem)] flex-col overflow-hidden p-0 sm:h-[680px]',
          // The chat panel needs a second column; widen only when it is open.
          isAgentChatOpen ? 'max-w-[1100px]' : 'max-w-3xl',
        )}
      >
        <DialogTitle>{title}</DialogTitle>

        <div className="flex flex-shrink-0 items-start justify-between gap-3 border-b border-border/60 px-4 py-4">
          <div className="min-w-0">
          <div className="text-base font-medium text-foreground">{title}</div>
          <div className="mt-1 text-sm text-muted-foreground">
            {mode === 'create'
              ? allowScopeSelection
                ? 'Author a skill from scratch, then choose whether it applies to every project or only selected projects.'
                : 'Author a skill from scratch. It installs into every agent\u2019s project skill folder.'
              : 'Changes are written to the canonical copy and every agent folder it was installed into.'}
          </div>
          </div>
          {canUseAgentChat && (
            <Button
              type="button"
              variant={isAgentChatOpen ? 'secondary' : 'outline'}
              size="sm"
              className="shrink-0"
              onClick={() => setIsAgentChatOpen((previous) => !previous)}
            >
              <Sparkles className="h-4 w-4" />
              Edit with agent
            </Button>
          )}
        </div>

        {isMemoryTemplate && (
          <div className="flex flex-shrink-0 items-center gap-2 border-b border-border/60 bg-muted/20 px-4 py-2 text-xs text-muted-foreground">
            <BrainCircuit className="h-3.5 w-3.5" />
            This is the managed memory contract. Saving re-renders it for every memory-enabled project.
          </div>
        )}

        {mode === 'create' && (
          <div className="grid flex-shrink-0 gap-3 border-b border-border/60 px-4 py-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Name</span>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="my-skill"
                className="h-9 w-full font-mono text-xs"
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Description</span>
              <Input
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="When and why an agent should use this skill"
                className="h-9 w-full"
              />
            </label>
          </div>
        )}

        {mode === 'create' && allowScopeSelection && (
          <div className="flex-shrink-0 border-b border-border/60 px-4 py-3">
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
          </div>
        )}

        {mode === 'create' && allowProviderSelection && (
          <div className="flex-shrink-0 border-b border-border/60 px-4 py-3">
            <ProviderBindingMatrix
              selected={selectedProviders}
              onChange={setSelectedProviders}
              providers={FANOUT_PROVIDERS}
            />
            <p className="mt-1.5 text-xs text-muted-foreground">
              Only checked agents receive a copy. The skill is stored once in CloudCLI.
            </p>
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
          <div className={cn(
            'min-h-0 flex-1 overflow-hidden transition-colors',
            agentFlash && 'bg-primary/10',
          )}>
          {isLoadingContent ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Loading skill…
            </div>
          ) : (
            <CodeMirror
              value={content}
              onChange={setContent}
              extensions={[markdown()]}
              theme={isDarkMode ? oneDark : undefined}
              height="100%"
              style={{ height: '100%', fontSize: '13px' }}
              basicSetup={{
                lineNumbers: true,
                foldGutter: false,
                dropCursor: false,
                allowMultipleSelections: false,
              }}
            />
          )}
          </div>

          {canUseAgentChat && (
            <SkillAgentPanel
              open={isAgentChatOpen}
              onClose={() => setIsAgentChatOpen(false)}
              projectPath={agentSessionPath}
              skillName={mode === 'create' ? (name || undefined) : skill?.name}
              getContent={getAgentContent}
              onDraft={handleAgentDraft}
            />
          )}
        </div>

        <div className="flex flex-shrink-0 flex-col gap-3 border-t border-border/60 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex-1">
            {error && (
              <div className="max-h-24 overflow-y-auto whitespace-pre-wrap rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800/60 dark:bg-red-900/20 dark:text-red-200">
                {error}
              </div>
            )}
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full sm:w-auto"
              disabled={isSaving}
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              className="w-full sm:w-auto"
              onClick={() => void handleSave()}
              disabled={isSaving || isLoadingContent || (mode === 'edit' && !isDirty) || (mode === 'create' && !canCreate)}
            >
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {mode === 'create' ? 'Create Skill' : 'Save Changes'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
