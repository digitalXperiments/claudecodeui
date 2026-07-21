import { useCallback, useMemo, useState } from 'react';
import {
  BrainCircuit,
  CheckCircle2,
  FileText,
  Globe,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Users,
  X,
} from 'lucide-react';

import { cn } from '../../../lib/utils';
import {
  Badge,
  Button,
  Input,
} from '../../../shared/view/ui';
import { useGlobalSkills } from '../hooks/useGlobalSkills';
import type { GlobalSkill, SkillsProvider } from '../types';

import SkillEditorDialog from './SkillEditorDialog';
import SkillUploadDialog from './SkillUploadDialog';

const PROVIDER_NAMES: Record<SkillsProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  grok: 'Grok',
  kimi: 'Kimi',
  agy: 'Antigravity',
};

const providerLabel = (provider: SkillsProvider): string => PROVIDER_NAMES[provider] ?? provider;

type EditorState = {
  mode: 'create' | 'edit';
  skill: GlobalSkill | null;
};

export default function GlobalSkills() {
  const {
    skills,
    isLoading,
    loadError,
    saveStatus,
    addSkills,
    removeSkill,
    getSkillContent,
    saveSkillContent,
    refreshSkills,
  } = useGlobalSkills();

  const [searchQuery, setSearchQuery] = useState('');
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [editorState, setEditorState] = useState<EditorState | null>(null);
  const [removingDirectory, setRemovingDirectory] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [justInstalled, setJustInstalled] = useState(false);

  const filteredSkills = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
    if (!normalizedQuery) {
      return skills;
    }

    return skills.filter((skill) => (
      [skill.name, skill.description, skill.directoryName, skill.sourcePath]
        .filter(Boolean)
        .some((value) => value.toLocaleLowerCase().includes(normalizedQuery))
    ));
  }, [searchQuery, skills]);

  // Unsupported agents are a property of the fan-out, identical on every skill.
  const unsupportedProviders = skills[0]?.unsupported ?? [];

  const handleRemove = useCallback(async (skill: GlobalSkill) => {
    setRemovingDirectory(skill.directoryName);
    setActionError(null);
    try {
      await removeSkill(skill.directoryName);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to remove global skill');
    } finally {
      setRemovingDirectory(null);
    }
  }, [removeSkill]);

  const handleEditorOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setEditorState(null);
    }
  }, []);

  return (
    <div className="min-w-0 space-y-4 overflow-x-hidden">
      <div className="flex min-w-0 items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/20 text-muted-foreground">
          <Globe className="h-4 w-4" strokeWidth={1.7} />
        </div>
        <div className="min-w-0 space-y-1">
          <h3 className="text-lg font-medium text-foreground">Global Skills</h3>
          <p className="text-sm text-muted-foreground">
            Author a skill once and install it into every agent&apos;s user skill folder, so it applies to all
            projects on this machine.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative min-w-0 flex-1 sm:max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search global skills..."
            aria-label="Search global skills"
            className="h-9 w-full pl-9 pr-9"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              aria-label="Clear skill search"
              className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <Button type="button" size="sm" className="w-full sm:w-auto" onClick={() => setEditorState({ mode: 'create', skill: null })}>
          <Plus className="h-4 w-4" />
          New Skill
        </Button>
        <Button type="button" variant="outline" size="sm" className="w-full sm:w-auto" onClick={() => setIsUploadOpen(true)}>
          <FileText className="h-4 w-4" />
          Upload Skill
        </Button>
        <Button
          onClick={() => void refreshSkills()}
          variant="outline"
          size="sm"
          className="w-full sm:w-auto"
          disabled={isLoading}
        >
          <RefreshCw className={cn('h-4 w-4', isLoading && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {unsupportedProviders.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <Users className="h-3.5 w-3.5" />
          <span>No user skill folder:</span>
          {unsupportedProviders.map((provider) => (
            <Badge key={provider} variant="outline" className="rounded-full bg-background/70 text-xs text-muted-foreground">
              {providerLabel(provider)}
            </Badge>
          ))}
        </div>
      )}

      {(actionError || loadError) && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800/60 dark:bg-red-900/20 dark:text-red-200">
          {actionError || loadError}
        </div>
      )}

      {justInstalled && saveStatus === 'success' && (
        <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 className="h-4 w-4" />
          Global skill installed for all agents.
        </div>
      )}

      <div className="space-y-3">
        {isLoading && skills.length === 0 && (
          <div className="flex min-h-[160px] items-center justify-center text-sm text-muted-foreground">
            Loading global skills…
          </div>
        )}

        {!isLoading && skills.length === 0 && (
          <div className="rounded-lg border border-dashed border-border/70 bg-muted/15 px-4 py-10 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-lg border border-border/60 bg-background/80 text-muted-foreground">
              <Globe className="h-6 w-6" />
            </div>
            <div className="mt-4 text-sm font-medium text-foreground">No global skills yet</div>
            <div className="mt-1 text-sm text-muted-foreground">
              Create or upload a skill to install it into every agent&apos;s user skill folder.
            </div>
          </div>
        )}

        {!isLoading && skills.length > 0 && filteredSkills.length === 0 && (
          <div className="rounded-lg border border-dashed border-border/70 bg-muted/15 px-4 py-10 text-center">
            <Search className="mx-auto h-6 w-6 text-muted-foreground" />
            <div className="mt-3 text-sm font-medium text-foreground">No matching skills</div>
          </div>
        )}

        <div className="grid min-w-0 gap-3 lg:grid-cols-2">
          {filteredSkills.map((skill) => (
            <div key={skill.directoryName} className="min-w-0 rounded-lg border border-border bg-card/50 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    <div className="break-all font-mono text-sm font-semibold text-foreground">{skill.name}</div>
                    {skill.kind === 'memory-template' && (
                      <Badge variant="outline" className="shrink-0 rounded-full border-sky-500/30 bg-sky-500/10 text-xs text-sky-700 dark:text-sky-300">
                        <BrainCircuit className="mr-1 h-3 w-3" />
                        Managed · Memory
                      </Badge>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">{skill.directoryName}</div>
                </div>
                <div className="flex flex-shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
                    aria-label={`Edit ${skill.name}`}
                    onClick={() => setEditorState({ mode: 'edit', skill })}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  {skill.kind !== 'memory-template' && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0 text-muted-foreground hover:text-red-600"
                      aria-label={`Remove ${skill.name}`}
                      disabled={removingDirectory === skill.directoryName}
                      onClick={() => void handleRemove(skill)}
                    >
                      {removingDirectory === skill.directoryName
                        ? <Loader2 className="h-4 w-4 animate-spin" />
                        : <Trash2 className="h-4 w-4" />}
                    </Button>
                  )}
                </div>
              </div>

              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                {skill.description || 'No description provided in the skill front matter.'}
              </p>

              {skill.kind === 'memory-template' ? (
                <div className="mt-4 text-xs text-muted-foreground">
                  Rendered with each project&apos;s vault folder when memory is enabled. Edits re-apply to all
                  memory-enabled projects.
                </div>
              ) : skill.providers.length > 0 ? (
                <div className="mt-4 flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Agents:</span>
                  {skill.providers.map((provider) => (
                    <Badge key={provider} variant="outline" className="rounded-full bg-background/70 text-xs">
                      {providerLabel(provider)}
                    </Badge>
                  ))}
                </div>
              ) : null}

              {skill.conflicts.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-amber-600 dark:text-amber-400">Skipped:</span>
                  {skill.conflicts.map((provider) => (
                    <Badge
                      key={provider}
                      variant="outline"
                      className="rounded-full border-amber-500/30 bg-amber-500/10 text-xs text-amber-700 dark:text-amber-300"
                    >
                      {providerLabel(provider)}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <SkillUploadDialog
        open={isUploadOpen}
        onOpenChange={setIsUploadOpen}
        onInstall={async (entries) => {
          await addSkills(entries);
          setJustInstalled(true);
        }}
        title="Add Global Skill"
        description="Upload a SKILL.md file or a complete skill folder. It installs into every agent's user skill folder and applies to all projects."
      />

      <SkillEditorDialog
        open={editorState !== null}
        onOpenChange={handleEditorOpenChange}
        mode={editorState?.mode ?? 'edit'}
        skill={editorState?.skill ?? null}
        loadContent={getSkillContent}
        saveContent={saveSkillContent}
        createSkill={async (entries) => {
          await addSkills(entries);
          setJustInstalled(true);
        }}
      />
    </div>
  );
}
