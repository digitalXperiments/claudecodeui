import type { ChatMessage } from '../types/types';

export type ExportFormat = 'markdown' | 'html' | 'pdf';

export interface ExportLabels {
  title: string;
  exported: string;
  user: string;
  assistant: string;
  thinking: string;
  tool: string;
  error: string;
  input: string;
  result: string;
  attachedImage: string;
}

export interface ExportOptions {
  includeMeta?: boolean;
  format?: ExportFormat;
  labels?: Partial<ExportLabels>;
}

const DEFAULT_LABELS: ExportLabels = {
  title: 'Chat Export',
  exported: 'Exported',
  user: 'You',
  assistant: 'Assistant',
  thinking: 'Thinking',
  tool: 'Tool',
  error: 'Error',
  input: 'Input',
  result: 'Result',
  attachedImage: 'Attached image',
};

function getLabels(labels?: Partial<ExportLabels>): ExportLabels {
  return { ...DEFAULT_LABELS, ...labels };
}

function formatTimestamp(date: Date | string | number): string {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return '';

  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(value);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function messageLabel(message: ChatMessage, labels: ExportLabels): string {
  if (message.type === 'user') return labels.user;
  if (message.type === 'error') return labels.error;
  if (message.isThinking) return labels.thinking;
  if (message.isToolUse || message.type === 'tool') return labels.tool;
  if (message.type === 'assistant') return labels.assistant;
  return message.type || labels.assistant;
}

function messageBody(message: ChatMessage, labels: ExportLabels): string {
  if (message.isToolUse || message.type === 'tool') {
    const parts: string[] = [];
    if (message.toolName) parts.push(String(message.toolName));

    const input = stringifyValue(message.toolInput);
    if (input) parts.push(`${labels.input}:\n${input}`);

    const result = message.toolResult?.content || '';
    if (result) parts.push(`${labels.result}:\n${result}`);

    return parts.join('\n\n');
  }

  const content = typeof message.content === 'string'
    ? message.content
    : stringifyValue(message.content);
  if (content.trim()) return content;

  if (message.images?.length) {
    const imageNames = message.images
      .map((image) => image.name || image.path)
      .filter(Boolean)
      .join(', ');
    return imageNames ? `${labels.attachedImage}: ${imageNames}` : labels.attachedImage;
  }

  return '';
}

function normalizedTitle(sessionTitle: string | undefined, fallback: string): string {
  const title = sessionTitle?.replace(/[\r\n]+/g, ' ').trim();
  return title || fallback;
}

/** Convert a conversation to Markdown suitable for saving or further editing. */
export function exportToMarkdown(
  messages: ChatMessage[],
  sessionTitle?: string,
  options: ExportOptions = {},
): string {
  const includeMeta = options.includeMeta ?? true;
  const labels = getLabels(options.labels);
  const title = normalizedTitle(sessionTitle, labels.title);
  let markdown = `# ${title}\n\n`;

  if (includeMeta) {
    markdown += `**${labels.exported}:** ${formatTimestamp(new Date())}\n\n---\n\n`;
  }

  for (const message of messages) {
    const body = messageBody(message, labels);
    if (!body) continue;

    markdown += `## ${messageLabel(message, labels)}\n\n${body}\n\n`;
    if (includeMeta && message.timestamp) {
      const timestamp = formatTimestamp(message.timestamp);
      if (timestamp) markdown += `<small>${timestamp}</small>\n\n`;
    }
    markdown += '---\n\n';
  }

  return markdown;
}

/** Convert a conversation to a self-contained, printable HTML document. */
export function exportToHTML(
  messages: ChatMessage[],
  sessionTitle?: string,
  options: ExportOptions = {},
): string {
  const includeMeta = options.includeMeta ?? true;
  const labels = getLabels(options.labels);
  const title = normalizedTitle(sessionTitle, labels.title);
  const messageMarkup = messages
    .map((message) => {
      const body = messageBody(message, labels);
      if (!body) return '';

      const timestamp = includeMeta && message.timestamp
        ? formatTimestamp(message.timestamp)
        : '';
      const isUser = message.type === 'user';

      return `
        <article class="message ${isUser ? 'user' : 'assistant'}">
          <h2>${escapeHtml(messageLabel(message, labels))}</h2>
          <div class="content">${escapeHtml(body)}</div>
          ${timestamp ? `<div class="timestamp">${escapeHtml(timestamp)}</div>` : ''}
        </article>
      `;
    })
    .join('');

  const exported = includeMeta
    ? `<div class="meta">${escapeHtml(labels.exported)} ${escapeHtml(formatTimestamp(new Date()))}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)}</title>
    <style>
      @page { margin: 18mm; }
      body {
        color: #222;
        background: #fff;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        line-height: 1.55;
        margin: 0 auto;
        max-width: 800px;
        padding: 24px;
      }
      h1 { font-size: 26px; margin: 0 0 6px; }
      .meta, .timestamp { color: #666; font-size: 12px; }
      .meta { margin-bottom: 24px; }
      .message {
        border: 1px solid #ddd;
        border-radius: 8px;
        margin: 0 0 18px;
        padding: 14px 16px;
        page-break-inside: avoid;
      }
      .message.user { background: #eef6ff; }
      .message.assistant { background: #f7f7f7; }
      h2 { font-size: 14px; margin: 0 0 8px; }
      .content { white-space: pre-wrap; overflow-wrap: anywhere; }
      .timestamp { margin-top: 10px; }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(title)}</h1>
    ${exported}
    ${messageMarkup}
  </body>
</html>`;
}

function downloadBlob(blob: Blob, filename: string): void {
  if (typeof document === 'undefined') return;

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadMarkdown(
  messages: ChatMessage[],
  filename = 'chat-export.md',
  sessionTitle?: string,
  options?: ExportOptions,
): void {
  const content = exportToMarkdown(messages, sessionTitle, options);
  downloadBlob(new Blob([content], { type: 'text/markdown;charset=utf-8' }), filename);
}

export function downloadHTML(
  messages: ChatMessage[],
  filename = 'chat-export.html',
  sessionTitle?: string,
  options?: ExportOptions,
): void {
  const content = exportToHTML(messages, sessionTitle, options);
  downloadBlob(new Blob([content], { type: 'text/html;charset=utf-8' }), filename);
}

/**
 * Open a printable PDF view. Browsers do not expose a PDF writer to web apps;
 * the print dialog's “Save as PDF” action is the native download flow.
 * Returns false when the browser blocks the print window.
 */
export function downloadPDF(
  messages: ChatMessage[],
  filename = 'chat-export',
  sessionTitle?: string,
  options?: ExportOptions,
): boolean {
  if (typeof window === 'undefined') return false;

  const printWindow = window.open('', '_blank', 'noopener,noreferrer,width=800,height=600');
  if (!printWindow) return false;

  printWindow.document.write(exportToHTML(messages, sessionTitle, options));
  printWindow.document.close();
  printWindow.document.title = `${filename}.pdf`;
  printWindow.focus();
  printWindow.setTimeout(() => printWindow.print(), 250);
  return true;
}

export const EXPORT_FORMATS: ReadonlyArray<{ id: ExportFormat; label: string; ext: string }> = [
  { id: 'markdown', label: 'Markdown (.md)', ext: '.md' },
  { id: 'html', label: 'HTML (.html)', ext: '.html' },
  { id: 'pdf', label: 'PDF (Print to file)', ext: '.pdf' },
];
