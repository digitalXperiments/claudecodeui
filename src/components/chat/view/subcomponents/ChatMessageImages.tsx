import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, File, FileSpreadsheet, FileText, X } from 'lucide-react';

import { authenticatedFetch } from '../../../../utils/api';
import type { ChatImage } from '../../types/types';

type ChatMessageImagesProps = {
  images: ChatImage[];
  projectId?: string | null;
};

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'];

/** Whether a stored attachment is an image (thumbnail) vs a document (chip). */
function isImageAttachment(image: ChatImage): boolean {
  if (image.data) {
    return image.data.startsWith('data:image/');
  }
  if (image.mimeType) {
    return image.mimeType.startsWith('image/');
  }
  const source = image.path || image.name || '';
  const extension = source.slice(source.lastIndexOf('.') + 1).toLowerCase();
  return IMAGE_EXTENSIONS.includes(extension);
}

/** Candidate URLs to fetch a stored attachment from, newest storage first. */
function attachmentUrls(path: string, projectId?: string | null): string[] {
  const filename = path.split(/[\\/]/).pop() || '';
  return [
    `/api/assets/images/${encodeURIComponent(filename)}`,
    ...(projectId
      ? [`/api/projects/${projectId}/files/content?path=${encodeURIComponent(path)}`]
      : []),
  ];
}

/**
 * Resolves one chat image to a displayable src. Inline data URLs are used
 * directly; path-based attachments are fetched as blobs (a bare <img src>
 * cannot carry the auth header) — first from the global assets route
 * (`~/.cloudcli/assets`), then from the project files route as a fallback for
 * sessions recorded before attachments moved to the global store.
 */
function useChatImageSrc(image: ChatImage, projectId?: string | null): { src: string | null; failed: boolean } {
  const [src, setSrc] = useState<string | null>(image.data || null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (image.data) {
      setSrc(image.data);
      setFailed(false);
      return;
    }

    const imagePath = image.path;
    if (!imagePath) {
      setSrc(null);
      setFailed(true);
      return;
    }

    const candidateUrls = attachmentUrls(imagePath, projectId);

    let objectUrl: string | null = null;
    const controller = new AbortController();

    const load = async () => {
      setFailed(false);
      for (const url of candidateUrls) {
        try {
          const response = await authenticatedFetch(url, { signal: controller.signal });
          if (!response.ok) {
            continue;
          }
          const blob = await response.blob();
          objectUrl = URL.createObjectURL(blob);
          setSrc(objectUrl);
          return;
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            return;
          }
        }
      }
      setSrc(null);
      setFailed(true);
    };

    void load();

    return () => {
      controller.abort();
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [image.data, image.path, projectId]);

  return { src, failed };
}

/**
 * Fullscreen image overlay in the claude.ai style: dark backdrop, centered
 * image, closes on backdrop click, close button, or Escape.
 */
function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={alt}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close image preview"
        className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20"
      >
        <X className="h-5 w-5" />
      </button>
      <img
        src={src}
        alt={alt}
        onClick={(event) => event.stopPropagation()}
        className="max-h-[90vh] max-w-[92vw] rounded-lg object-contain shadow-2xl"
      />
    </div>,
    document.body,
  );
}

function ChatMessageImage({ image, projectId }: { image: ChatImage; projectId?: string | null }) {
  const { src, failed } = useChatImageSrc(image, projectId);
  const [expanded, setExpanded] = useState(false);
  const alt = image.name || 'Attached image';

  if (failed) {
    return (
      <div className="flex h-28 w-28 items-center justify-center rounded-xl border border-border/50 bg-muted px-2 text-center text-[10px] text-muted-foreground">
        {alt}
      </div>
    );
  }

  if (!src) {
    return <div className="h-28 w-28 animate-pulse rounded-xl border border-border/50 bg-muted" />;
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setExpanded(true)}
        aria-label={`Expand ${alt}`}
        className="block overflow-hidden rounded-xl border border-border/50 shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/60"
      >
        <img
          src={src}
          alt={alt}
          className="h-28 w-28 cursor-zoom-in object-cover transition-transform duration-200 hover:scale-105"
        />
      </button>
      {expanded && <ImageLightbox src={src} alt={alt} onClose={() => setExpanded(false)} />}
    </>
  );
}

function iconForAttachment(name: string) {
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (['csv', 'tsv', 'xls', 'xlsx', 'ods'].includes(extension)) {
    return FileSpreadsheet;
  }
  if (['pdf', 'txt', 'md', 'markdown', 'json', 'xml', 'html', 'htm', 'rtf', 'log', 'yaml', 'yml', 'doc', 'docx', 'ppt', 'pptx', 'odt', 'odp'].includes(extension)) {
    return FileText;
  }
  return File;
}

/**
 * A non-image attachment on a past user turn: a downloadable chip. Clicking
 * fetches the stored asset as a blob (an authenticated request, so a bare
 * anchor href cannot be used) and triggers a browser download.
 */
function ChatMessageFile({ image, projectId }: { image: ChatImage; projectId?: string | null }) {
  const [downloading, setDownloading] = useState(false);
  const name = image.name || image.path?.split(/[\\/]/).pop() || 'attachment';
  const Icon = iconForAttachment(name);

  const handleDownload = async () => {
    if (image.data) {
      const link = document.createElement('a');
      link.href = image.data;
      link.download = name;
      link.click();
      return;
    }
    if (!image.path || downloading) {
      return;
    }
    setDownloading(true);
    try {
      for (const url of attachmentUrls(image.path, projectId)) {
        try {
          const response = await authenticatedFetch(url);
          if (!response.ok) {
            continue;
          }
          const blob = await response.blob();
          const objectUrl = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = objectUrl;
          link.download = name;
          link.click();
          URL.revokeObjectURL(objectUrl);
          return;
        } catch {
          // Try the next candidate URL.
        }
      }
    } finally {
      setDownloading(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleDownload}
      disabled={downloading}
      className="group flex max-w-52 items-center gap-2 rounded-xl border border-border/50 bg-background/60 px-3 py-2 text-left shadow-sm transition-colors hover:bg-accent/50 focus:outline-none focus:ring-2 focus:ring-primary/60"
      title={`Download ${name}`}
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon className="h-4 w-4" />
      </div>
      <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{name}</span>
      <Download className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}

/**
 * Attachments for a user turn, rendered claude.ai-style above the message
 * bubble: images as thumbnails that expand to a fullscreen lightbox, and
 * documents as downloadable chips.
 */
export default function ChatMessageImages({ images, projectId }: ChatMessageImagesProps) {
  if (!images || images.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap justify-end gap-2">
      {images.map((image, index) => {
        const key = image.path || image.name || index;
        return isImageAttachment(image) ? (
          <ChatMessageImage key={key} image={image} projectId={projectId} />
        ) : (
          <ChatMessageFile key={key} image={image} projectId={projectId} />
        );
      })}
    </div>
  );
}
