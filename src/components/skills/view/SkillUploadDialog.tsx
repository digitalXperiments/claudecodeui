import { useCallback, useRef, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import {
  FileText,
  FileUp,
  FolderUp,
  Loader2,
  Upload,
  X,
} from 'lucide-react';

import { cn } from '../../../lib/utils';
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
} from '../../../shared/view/ui';
import {
  buildQueuedSkillFolders,
  buildSkillCreateEntries,
  formatFileSize,
  getBrowserRelativePath,
  MAX_SKILL_FOLDER_FILES,
  type QueuedSkillFile,
} from '../lib/skillUpload';
import type { ProviderSkillCreateEntryPayload } from '../types';

type SkillUploadDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstall: (entries: ProviderSkillCreateEntryPayload[]) => Promise<unknown>;
  title: string;
  description: string;
};

const MAX_QUEUED_SKILLS = 20;

/**
 * Self-contained "upload a skill" dialog: drop a SKILL.md or a whole skill
 * folder, review the queue, install. Used by both the Project Skills and
 * Global Skills tabs.
 */
export default function SkillUploadDialog({
  open,
  onOpenChange,
  onInstall,
  title,
  description,
}: SkillUploadDialogProps) {
  const [queuedFiles, setQueuedFiles] = useState<QueuedSkillFile[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  const setFolderInputRef = useCallback((node: HTMLInputElement | null) => {
    folderInputRef.current = node;
    if (!node) {
      return;
    }
    node.setAttribute('webkitdirectory', '');
    node.setAttribute('directory', '');
  }, []);

  const queueSkillFolders = useCallback((selectedFiles: File[]) => {
    const queuedFolders = buildQueuedSkillFolders(selectedFiles);
    setQueuedFiles((previous) => {
      const nextMap = new Map(previous.map((file) => [file.id, file]));
      queuedFolders.forEach((folder) => nextMap.set(folder.id, folder));
      return [...nextMap.values()].slice(0, MAX_QUEUED_SKILLS);
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
      .slice(0, MAX_QUEUED_SKILLS);

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
      return [...nextMap.values()].slice(0, MAX_QUEUED_SKILLS);
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

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setQueuedFiles([]);
    setSubmitError(null);
    onOpenChange(nextOpen);
  }, [onOpenChange]);

  const handleInstall = useCallback(async () => {
    if (queuedFiles.length === 0) {
      setSubmitError('Add one or more markdown files first.');
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const entries = await buildSkillCreateEntries(queuedFiles);
      await onInstall(entries);
      setQueuedFiles([]);
      onOpenChange(false);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Failed to import skills');
    } finally {
      setIsSubmitting(false);
    }
  }, [onInstall, onOpenChange, queuedFiles]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        wrapperClassName="z-[10000]"
        className="flex h-[calc(100vh-2rem)] max-h-[720px] w-[calc(100vw-2rem)] max-w-3xl flex-col overflow-hidden p-0 sm:h-[640px]"
      >
        <DialogTitle>{title}</DialogTitle>
        <div className="flex-shrink-0 border-b border-border/60 px-4 py-4">
          <div className="text-base font-medium text-foreground">{title}</div>
          <div className="mt-1 text-sm text-muted-foreground">{description}</div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
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
                    Installed into every agent&apos;s skill folder.
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
            <Button type="button" variant="outline" size="sm" className="w-full sm:w-auto" disabled={isSubmitting} onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" size="sm" className="w-full sm:w-auto" onClick={() => void handleInstall()} disabled={isSubmitting || queuedFiles.length === 0}>
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              Install {queuedFiles.length > 0 ? `${queuedFiles.length} Skill${queuedFiles.length === 1 ? '' : 's'}` : 'Skill'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
