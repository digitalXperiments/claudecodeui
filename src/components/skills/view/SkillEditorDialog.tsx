import { useCallback, useEffect, useMemo, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { BrainCircuit, Loader2, Save } from 'lucide-react';

import { useTheme } from '../../../contexts/ThemeContext';
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Input,
} from '../../../shared/view/ui';
import type { ProviderSkillCreateEntryPayload } from '../types';

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
  createSkill: (entries: ProviderSkillCreateEntryPayload[]) => Promise<unknown>;
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
}: SkillEditorDialogProps) {
  const { isDarkMode } = useTheme();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [isLoadingContent, setIsLoadingContent] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // (Re)initialize state whenever the dialog is opened for a skill/mode.
  useEffect(() => {
    if (!open) {
      return;
    }

    setError(null);
    setIsSaving(false);
    if (mode === 'create') {
      setName('');
      setDescription('');
      setContent(CREATE_BODY_SKELETON);
      setOriginalContent('');
      setIsLoadingContent(false);
      return;
    }

    if (!skill) {
      return;
    }

    setIsLoadingContent(true);
    setContent('');
    setOriginalContent('');
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
  }, [open, mode, skill, loadContent]);

  const isDirty = useMemo(() => {
    if (mode === 'create') {
      return Boolean(name.trim()) || content !== CREATE_BODY_SKELETON;
    }
    return content !== originalContent;
  }, [mode, name, content, originalContent]);

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
        await createSkill([{
          content: buildCreateContent(directoryName, description, content),
          directoryName,
        }]);
      } else if (skill) {
        await saveContent(skill.directoryName, content.trim());
      }
      onOpenChange(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save skill');
    } finally {
      setIsSaving(false);
    }
  }, [mode, name, description, content, skill, createSkill, saveContent, onOpenChange]);

  const isMemoryTemplate = skill?.kind === 'memory-template';
  const title = mode === 'create'
    ? 'New Skill'
    : `Edit ${isMemoryTemplate ? 'Memory Skill Template' : (skill?.name ?? 'Skill')}`;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        wrapperClassName="z-[10000]"
        className="flex h-[calc(100vh-2rem)] max-h-[760px] w-[calc(100vw-2rem)] max-w-3xl flex-col overflow-hidden p-0 sm:h-[680px]"
      >
        <DialogTitle>{title}</DialogTitle>

        <div className="flex-shrink-0 border-b border-border/60 px-4 py-4">
          <div className="text-base font-medium text-foreground">{title}</div>
          <div className="mt-1 text-sm text-muted-foreground">
            {mode === 'create'
              ? 'Author a skill from scratch. It installs into every agent\u2019s skill folder.'
              : 'Changes are written to the canonical copy and every agent folder it was installed into.'}
          </div>
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

        <div className="min-h-0 flex-1 overflow-hidden">
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
              disabled={isSaving || isLoadingContent || (mode === 'edit' && !isDirty)}
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
