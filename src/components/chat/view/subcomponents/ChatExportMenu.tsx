import { useMemo, useState } from 'react';
import { Download, FileCode2, FileDown, FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ChatMessage } from '../../types/types';
import {
  downloadHTML,
  downloadMarkdown,
  downloadPDF,
  EXPORT_FORMATS,
  type ExportFormat,
  type ExportLabels,
} from '../../utils/chatExport';

type ChatExportMenuProps = {
  messages: ChatMessage[];
  sessionTitle?: string;
  onPrepareExport?: () => Promise<ChatMessage[]>;
  disabled?: boolean;
};

const filenamePart = (value: string): string => (
  value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    || 'chat'
);

export default function ChatExportMenu({ messages, sessionTitle, onPrepareExport, disabled = false }: ChatExportMenuProps) {
  const { t } = useTranslation('chat');
  const [isOpen, setIsOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const labels = useMemo<ExportLabels>(() => ({
    title: t('export.title', { defaultValue: 'Chat Export' }),
    exported: t('export.exported', { defaultValue: 'Exported' }),
    user: t('export.you', { defaultValue: 'You' }),
    assistant: t('export.assistant', { defaultValue: 'Assistant' }),
    thinking: t('export.thinking', { defaultValue: 'Thinking' }),
    tool: t('export.tool', { defaultValue: 'Tool' }),
    error: t('export.error', { defaultValue: 'Error' }),
    input: t('export.input', { defaultValue: 'Input' }),
    result: t('export.result', { defaultValue: 'Result' }),
    attachedImage: t('export.attachedImage', { defaultValue: 'Attached image' }),
  }), [t]);

  const formatLabels = useMemo<Record<ExportFormat, string>>(() => ({
    markdown: t('export.formats.markdown', { defaultValue: 'Markdown (.md)' }),
    html: t('export.formats.html', { defaultValue: 'HTML (.html)' }),
    pdf: t('export.formats.pdf', { defaultValue: 'PDF (Print to file)' }),
  }), [t]);

  if (messages.length === 0) return null;

  const handleExport = async (format: ExportFormat) => {
    if (isExporting) return;

    setIsExporting(true);
    setError(null);
    try {
      const exportMessages = onPrepareExport ? await onPrepareExport() : messages;
      if (exportMessages.length === 0) return;

      const filename = `${filenamePart(sessionTitle || labels.title)}-${new Date().toISOString().slice(0, 10)}`;
      const options = { labels };
      if (format === 'markdown') {
        downloadMarkdown(exportMessages, `${filename}.md`, sessionTitle, options);
      } else if (format === 'html') {
        downloadHTML(exportMessages, `${filename}.html`, sessionTitle, options);
      } else if (!downloadPDF(exportMessages, filename, sessionTitle, options)) {
        setError(t('export.popupBlocked', {
          defaultValue: 'Allow pop-ups to save this conversation as a PDF.',
        }));
        return;
      }
      setIsOpen(false);
    } catch (exportError) {
      console.error('[ChatExport] Failed to export conversation:', exportError);
      setError(t('export.failed', { defaultValue: 'Unable to export this conversation.' }));
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => {
          setError(null);
          setIsOpen((previous) => !previous);
        }}
        aria-label={t('export.button', { defaultValue: 'Export chat' })}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        title={t('export.button', { defaultValue: 'Export chat' })}
        className="flex h-8 w-8 items-center justify-center rounded-lg border border-border/50 bg-card text-muted-foreground shadow-sm transition-all hover:bg-accent hover:text-foreground"
      >
        {isExporting ? (
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
        ) : (
          <Download className="h-4 w-4" aria-hidden />
        )}
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} aria-hidden />
          <div
            className="absolute right-0 top-full z-50 mt-2 w-52 rounded-lg border border-border/50 bg-card p-2 shadow-lg"
            role="menu"
            aria-label={t('export.heading', { defaultValue: 'Export as' })}
          >
            <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
              {t('export.heading', { defaultValue: 'Export as' })}
            </div>
            {EXPORT_FORMATS.map(({ id }) => (
              <button
                key={id}
                type="button"
                role="menuitem"
        disabled={disabled || isExporting}
                onClick={() => void handleExport(id)}
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-muted disabled:cursor-wait disabled:opacity-60"
              >
                {id === 'markdown' ? (
                  <FileText className="h-4 w-4" aria-hidden />
                ) : id === 'html' ? (
                  <FileCode2 className="h-4 w-4" aria-hidden />
                ) : (
                  <FileDown className="h-4 w-4" aria-hidden />
                )}
                <span>{formatLabels[id]}</span>
              </button>
            ))}
            {error && <p className="px-2 pb-1 pt-2 text-xs text-destructive">{error}</p>}
          </div>
        </>
      )}
    </div>
  );
}
