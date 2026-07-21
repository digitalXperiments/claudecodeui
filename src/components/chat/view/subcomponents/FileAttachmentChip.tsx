import { File, FileArchive, FileSpreadsheet, FileText, XIcon } from 'lucide-react';
import type { ComponentType } from 'react';

interface FileAttachmentChipProps {
  file: File;
  onRemove: () => void;
  uploadProgress?: number;
  error?: string;
}

/** Picks a representative icon for a filename by extension. */
function iconForFile(name: string): ComponentType<{ className?: string }> {
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (['csv', 'tsv', 'xls', 'xlsx', 'ods'].includes(extension)) {
    return FileSpreadsheet;
  }
  if (['zip', 'gz', 'tar', 'rar', '7z'].includes(extension)) {
    return FileArchive;
  }
  if (['pdf', 'txt', 'md', 'markdown', 'json', 'xml', 'html', 'htm', 'rtf', 'log', 'yaml', 'yml', 'doc', 'docx', 'ppt', 'pptx', 'odt', 'odp'].includes(extension)) {
    return FileText;
  }
  return File;
}

function formatSize(bytes: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Compact chip for a non-image attachment (PDF, spreadsheet, text, …) shown in
 * the composer above the input. Mirrors {@link ImageAttachment}'s remove /
 * progress / error affordances but renders a file icon + name instead of a
 * thumbnail.
 */
const FileAttachmentChip = ({ file, onRemove, uploadProgress, error }: FileAttachmentChipProps) => {
  const Icon = iconForFile(file.name);

  return (
    <div className="group relative flex max-w-52 items-center gap-2 rounded-xl border border-border/50 bg-background/60 px-3 py-2 shadow-sm">
      <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${error ? 'bg-red-500/15 text-red-500' : 'bg-primary/10 text-primary'}`}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-foreground" title={file.name}>
          {file.name}
        </div>
        <div className="text-[10px] text-muted-foreground">
          {error
            ? error
            : uploadProgress !== undefined && uploadProgress < 100
              ? `${uploadProgress}%`
              : formatSize(file.size)}
        </div>
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="absolute -right-1.5 -top-1.5 rounded-full border border-border/40 bg-background/90 p-1 text-foreground shadow-sm backdrop-blur transition-opacity hover:bg-background focus:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
        aria-label="Remove file"
      >
        <XIcon className="h-3 w-3" />
      </button>
    </div>
  );
};

export default FileAttachmentChip;
