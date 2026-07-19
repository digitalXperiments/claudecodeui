import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import {
  CheckCircle2,
  FileText,
  FileUp,
  FolderUp,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  Users,
  X,
} from 'lucide-react';

import { cn } from '../../../lib/utils';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Input,
} from '../../../shared/view/ui';
import { useProjectSkills } from '../hooks/useProjectSkills';
import {
  buildQueuedSkillFolders,
  buildSkillCreateEntries,
  formatFileSize,
  getBrowserRelativePath,
  MAX_SKILL_FOLDER_FILES,
  type QueuedSkillFile,
} from '../lib/skillUpload';
import type { ProjectSkill, SkillsProject, SkillsProvider } from '../types';

type ProjectSkillsProps = {
  currentProjects: SkillsProject[];
};

type ProjectTarget = {
  projectId: string;
  displayName: string;
  path: string;
};

const PROVIDER_NAMES: Record<SkillsProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  grok: 'Grok',
  kimi: 'Kimi',
  agy: 'Antigravity',
};

const createProjectTargets = (projects: SkillsProject[]): ProjectTarget[] => {
  const seenPaths = new Set<string>();

  return projects.reduce<ProjectTarget[]>((acc, project) => {
    const projectPath = project.fullPath || project.path || '';
    if (!projectPath || seenPaths.has(projectPath)) {
      return acc;
    }

    seenPaths.add(projectPath);
    acc.push({
      projectId: project.projectId,
      displayName: project.displayName || project.projectId,
      path: projectPath,
    });
    return acc;
  }, []);
};

const providerLabel = (provider: SkillsProvider): string => PROVIDER_NAMES[provider] ?? provider;

export default function ProjectSkills({ currentProjects }: ProjectSkillsProps) {
  const projectTargets = useMemo(() => createProjectTargets(currentProjects), [currentProjects]);
  const [selectedPath, setSelectedPath] = useState<string | null>(projectTargets[0]?.path ?? null);

  useEffect(() => {
    setSelectedPath((current) => {
      if (current && projectTargets.some((project) => project.path === current)) {
        return current;
      }
      return projectTargets[0]?.path ?? null;
    });
  }, [projectTargets]);

  const {
    skills,
    isLoading,
    loadError,
    saveStatus,
    addSkills,
    removeSkill,
    refreshSkills,
  } = useProjectSkills({ workspacePath: selectedPath });

  const [queuedFiles, setQueuedFiles] = useState<QueuedSkillFile[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [justInstalled, setJustInstalled] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [removingDirectory, setRemovingDirectory] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  const selectedProject = projectTargets.find((project) => project.path === selectedPath) ?? null;

  useEffect(() => {
    setQueuedFiles([]);
    setSubmitError(null);
    setSearchQuery('');
    setJustInstalled(false);
  }, [selectedPath]);

  const setFolderInputRef = useCallback((node: HTMLInputElement | null) => {
    folderInputRef.current = node;
    if (!node) {
      return;
    }
    node.setAttribute('webkitdirectory', '');
    node.setAttribute('directory', '');
  }, []);

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

  const queueSkillFolders = useCallback((selectedFiles: File[]) => {
    const queuedFolders = buildQueuedSkillFolders(selectedFiles);
    setQueuedFiles((previous) => {
      const nextMap = new Map(previous.map((file) => [file.id, file]));
      queuedFolders.forEach((folder) => nextMap.set(folder.id, folder));
      return [...nextMap.values()].slice(0, 20);
    });
  }, []);

  const handleDrop = useCallback((files: File[]) => {
    const includesDirectory = files.some((file) => getBrowserRelativePath(file).includes('/'));
    if (includesDirectory) {
      try {
        queueSkillFolders(files);
        setSubmitError(null);
      } catch (error) {
        setSubmitError(error instanceof Error ? error.message : 'Failed to read skill folder');
      }
      return;
    }

    const acceptedFiles = files
      .filter((file) => file.name.toLowerCase().endsWith('.md'))
      .slice(0, 20);

    if (acceptedFiles.length === 0) {
      setSubmitError('Drop one or more markdown files or a folder containing SKILL.md.');
      return;
    }

    setQueuedFiles((previous) => {
      const nextMap = new Map(previous.map((file) => [file.id, file]));
      acceptedFiles.forEach((file) => {
        const id = `${file.name}:${file.size}:${file.lastModified}`;
        nextMap.set(id, {
          id,
          name: file.name,
          size: file.size,
          kind: 'markdown',
          skillFile: file,
          files: [{ file, relativePath: 'SKILL.md' }],
        });
      });
      return [...nextMap.values()].slice(0, 20);
    });
    setSubmitError(null);
  }, [queueSkillFolders]);

  const handleFolderSelection = useCallback((selectedFiles: File[]) => {
    if (selectedFiles.length === 0) {
      return;
    }
    try {
      queueSkillFolders(selectedFiles);
      setSubmitError(null);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Failed to read skill folder');
    }
  }, [queueSkillFolders]);

  const { getRootProps, isDragActive } = useDropzone({
    maxFiles: MAX_SKILL_FOLDER_FILES,
    noClick: true,
    noKeyboard: true,
    onDrop: handleDrop,
  });

  const handleAddDialogOpenChange = useCallback((open: boolean) => {
    setQueuedFiles([]);
    setSubmitError(null);
    setJustInstalled(false);
    setIsAddDialogOpen(open);
  }, []);

  const handleUploadInstall = useCallback(async () => {
    if (queuedFiles.length === 0) {
      setSubmitError('Add one or more markdown files first.');
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const entries = await buildSkillCreateEntries(queuedFiles);
      await addSkills(entries);
      setQueuedFiles([]);
      setJustInstalled(true);
      setIsAddDialogOpen(false);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Failed to import skills');
    } finally {
      setIsSubmitting(false);
    }
  }, [addSkills, queuedFiles]);

  const handleRemove = useCallback(async (skill: ProjectSkill) => {
    setRemovingDirectory(skill.directoryName);
    setSubmitError(null);
    try {
      await removeSkill(skill.directoryName);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Failed to remove project skill');
    } finally {
      setRemovingDirectory(null);
    }
  }, [removeSkill]);

  const uploadPanel = (
    <div className="space-y-4">
      <div
        {...getRootProps()}
        className={cn(
          'rounded-lg border border-dashed p-4 transition-colors sm:p-5',
          isDragActive
            ? 'border-foreground/40 bg-muted/35'
            : 'border-border/70 bg-muted/15 hover:border-foreground/25 hover:bg-muted/25',
        )}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".md,text/markdown"
          multiple
          className="hidden"
          onChange={(event) => {
            handleDrop(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
        <input
          ref={setFolderInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            handleFolderSelection(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
        <div className="flex flex-col items-center justify-center gap-3 py-4 text-center">
          <FileUp className="h-7 w-7 text-muted-foreground" strokeWidth={1.5} />
          <div className="space-y-1">
            <div className="text-sm font-medium text-foreground">Drop a skill folder or SKILL.md</div>
            <div className="text-sm text-muted-foreground">
              Installed into every agent&apos;s project skill folder.
            </div>
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
            <Button type="button" variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} className="w-full sm:w-auto">
              <FileUp className="h-4 w-4" />
              Choose Files
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => folderInputRef.current?.click()} className="w-full sm:w-auto">
              <FolderUp className="h-4 w-4" />
              Choose Folder
            </Button>
          </div>
        </div>
      </div>

      {queuedFiles.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm font-medium text-foreground">Ready to install</div>
          <div className="grid gap-2">
            {queuedFiles.map((queuedFile) => (
              <div key={queuedFile.id} className="flex items-center gap-3 rounded-lg border border-border/70 bg-background/70 px-3 py-2">
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-muted/60 text-muted-foreground">
                  {queuedFile.kind === 'folder' ? <FolderUp className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-foreground">{queuedFile.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {queuedFile.kind === 'folder' ? `${queuedFile.files.length} files` : 'Markdown file'}
                    {' · '}
                    {formatFileSize(queuedFile.size)}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 flex-shrink-0 p-0 text-muted-foreground hover:text-foreground"
                  aria-label={`Remove ${queuedFile.name}`}
                  onClick={() => setQueuedFiles((previous) => previous.filter((file) => file.id !== queuedFile.id))}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="min-w-0 space-y-4 overflow-x-hidden">
      <div className="flex min-w-0 items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/20 text-muted-foreground">
          <Users className="h-4 w-4" strokeWidth={1.7} />
        </div>
        <div className="min-w-0 space-y-1">
          <h3 className="text-lg font-medium text-foreground">Project Skills</h3>
          <p className="text-sm text-muted-foreground">
            Author a skill once and install it into every agent&apos;s project skill folder, so any agent you run in this
            project can use it.
          </p>
        </div>
      </div>

      {projectTargets.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/70 bg-muted/15 px-4 py-10 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-lg border border-border/60 bg-background/80 text-muted-foreground">
            <FileText className="h-6 w-6" />
          </div>
          <div className="mt-4 text-sm font-medium text-foreground">No project selected</div>
          <div className="mt-1 text-sm text-muted-foreground">
            Open a project to author cross-agent project skills.
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            {projectTargets.length > 1 && (
              <select
                value={selectedPath ?? ''}
                onChange={(event) => setSelectedPath(event.target.value)}
                aria-label="Select project"
                className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-3 text-sm text-foreground sm:max-w-xs"
              >
                {projectTargets.map((project) => (
                  <option key={project.path} value={project.path}>{project.displayName}</option>
                ))}
              </select>
            )}
            <div className="relative min-w-0 flex-1 sm:max-w-md">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="text"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search project skills..."
                aria-label="Search project skills"
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
            <Button type="button" size="sm" className="w-full sm:w-auto" onClick={() => handleAddDialogOpenChange(true)}>
              <Plus className="h-4 w-4" />
              Add Skill
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

          {selectedProject && (
            <div className="rounded-lg border border-border/60 bg-muted/15 px-3 py-2">
              <code className="block whitespace-normal break-all text-xs text-foreground">{selectedProject.path}</code>
            </div>
          )}

          {(submitError || loadError) && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800/60 dark:bg-red-900/20 dark:text-red-200">
              {submitError || loadError}
            </div>
          )}

          {justInstalled && saveStatus === 'success' && (
            <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="h-4 w-4" />
              Project skill installed for all agents.
            </div>
          )}

          <div className="space-y-3">
            {isLoading && skills.length === 0 && (
              <div className="flex min-h-[160px] items-center justify-center text-sm text-muted-foreground">
                Loading project skills…
              </div>
            )}

            {!isLoading && skills.length === 0 && (
              <div className="rounded-lg border border-dashed border-border/70 bg-muted/15 px-4 py-10 text-center">
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-lg border border-border/60 bg-background/80 text-muted-foreground">
                  <FileText className="h-6 w-6" />
                </div>
                <div className="mt-4 text-sm font-medium text-foreground">No project skills yet</div>
                <div className="mt-1 text-sm text-muted-foreground">
                  Add a skill to install it into every agent&apos;s project folder.
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
                      <div className="break-all font-mono text-sm font-semibold text-foreground">{skill.name}</div>
                      <div className="text-xs text-muted-foreground">{skill.directoryName}</div>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 flex-shrink-0 p-0 text-muted-foreground hover:text-red-600"
                      aria-label={`Remove ${skill.name}`}
                      disabled={removingDirectory === skill.directoryName}
                      onClick={() => void handleRemove(skill)}
                    >
                      {removingDirectory === skill.directoryName
                        ? <Loader2 className="h-4 w-4 animate-spin" />
                        : <Trash2 className="h-4 w-4" />}
                    </Button>
                  </div>

                  <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                    {skill.description || 'No description provided in the skill front matter.'}
                  </p>

                  {skill.providers.length > 0 && (
                    <div className="mt-4 flex flex-wrap items-center gap-1.5">
                      <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Agents:</span>
                      {skill.providers.map((provider) => (
                        <Badge key={provider} variant="outline" className="rounded-full bg-background/70 text-xs">
                          {providerLabel(provider)}
                        </Badge>
                      ))}
                    </div>
                  )}

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
        </>
      )}

      <Dialog open={isAddDialogOpen} onOpenChange={handleAddDialogOpenChange}>
        <DialogContent
          wrapperClassName="z-[10000]"
          className="flex h-[calc(100vh-2rem)] max-h-[720px] w-[calc(100vw-2rem)] max-w-3xl flex-col overflow-hidden p-0 sm:h-[640px]"
        >
          <DialogTitle>Add Project Skill</DialogTitle>
          <div className="flex-shrink-0 border-b border-border/60 px-4 py-4">
            <div className="text-base font-medium text-foreground">Add Project Skill</div>
            <div className="mt-1 text-sm text-muted-foreground">
              Upload a SKILL.md file or a complete skill folder. It installs into every agent&apos;s project skill folder.
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {uploadPanel}
          </div>

          <div className="flex flex-shrink-0 flex-col gap-3 border-t border-border/60 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 flex-1">
              {submitError ? (
                <div className="max-h-24 overflow-y-auto whitespace-pre-wrap rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800/60 dark:bg-red-900/20 dark:text-red-200">
                  {submitError}
                </div>
              ) : (
                <span className="text-xs text-muted-foreground">
                  Folder uploads keep the folder name; standalone files use the `name` in `SKILL.md`.
                </span>
              )}
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
              <Button type="button" variant="outline" size="sm" className="w-full sm:w-auto" disabled={isSubmitting} onClick={() => handleAddDialogOpenChange(false)}>
                Cancel
              </Button>
              <Button type="button" size="sm" className="w-full sm:w-auto" onClick={() => void handleUploadInstall()} disabled={isSubmitting || queuedFiles.length === 0}>
                {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                Install {queuedFiles.length > 0 ? `${queuedFiles.length} Skill${queuedFiles.length === 1 ? '' : 's'}` : 'Skill'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
