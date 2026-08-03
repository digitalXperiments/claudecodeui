/**
 * X article draft model + exporters.
 *
 * The x.com Article editor does not parse markdown, but it does accept pasted
 * rich text — which is how every markdown-to-X tool works. So the copy path
 * writes two clipboard flavors:
 *   - `text/html`  → headings, lists, quotes, code blocks, bold/italic/links
 *   - `text/plain` → a readable markdown fallback for anywhere else
 *
 * Images are the one thing paste cannot carry: they have to be uploaded in the
 * editor. Each one therefore becomes a numbered "[Image n]" marker in the
 * pasted text, and the image tray hands you the files to drop at those markers.
 *
 * Code blocks are emitted as real `<pre><code>` so they render natively when
 * the editor supports it; the matching code-card image stays in the tray as a
 * fallback you can drop in instead if a paste ever comes through unstyled.
 */

export const X_ARTICLE_BODY_KIND = 'x_article';

export type XArticleBlock =
  | { type: 'p'; text: string }
  | { type: 'h2'; text: string }
  | { type: 'h3'; text: string }
  | { type: 'list'; ordered?: boolean; items: string[] }
  | { type: 'quote'; text: string }
  | { type: 'callout'; tone?: 'gotcha' | 'tip'; text: string }
  | { type: 'code'; codeId: string }
  | { type: 'image'; imageId: string };

export type XArticleCode = {
  id: string;
  lang: string;
  caption?: string;
  source: string;
};

export type XArticleImageStatus = 'ready' | 'skipped' | 'failed';

export type XArticleImage = {
  id: string;
  kind: 'code-card' | 'screenshot';
  codeId?: string;
  route?: string;
  alt: string;
  caption?: string;
  assetUrl?: string;
  assetPath?: string;
  width?: number;
  height?: number;
  status?: XArticleImageStatus;
  statusMessage?: string;
};

export type XArticleBody = {
  kind: typeof X_ARTICLE_BODY_KIND;
  v: number;
  slug: string;
  /** Which story shape the draft committed to. */
  angle?: 'build-story' | 'reversal' | 'escape' | 'constraint';
  /** One-line "I wanted X, assumed Y, hit Z, W fixed it". */
  pitch?: string;
  headline: string;
  /** The runners-up, so a weak headline can be swapped without a re-run. */
  titleVariants?: string[];
  dek?: string;
  hook?: string;
  readingMinutes?: number;
  blocks: XArticleBlock[];
  code?: XArticleCode[];
  images?: XArticleImage[];
  promoThread?: string[];
  tags?: string[];
  sources?: Array<{ note: string; why?: string }>;
  factCheck?: Array<{ claim: string; evidencePath?: string }>;
};

export function isXArticleBody(body: unknown): body is XArticleBody {
  if (!body || typeof body !== 'object') return false;
  const candidate = body as Partial<XArticleBody>;
  return (
    candidate.kind === X_ARTICLE_BODY_KIND &&
    typeof candidate.headline === 'string' &&
    Array.isArray(candidate.blocks)
  );
}

/** Images in the order they appear in the article, so tray numbers match markers. */
export function orderedImages(article: XArticleBody): XArticleImage[] {
  const byId = new Map((article.images ?? []).map((image) => [image.id, image]));
  const ordered: XArticleImage[] = [];
  const seen = new Set<string>();

  for (const block of article.blocks) {
    let image: XArticleImage | undefined;
    if (block.type === 'image') {
      image = byId.get(block.imageId);
    } else if (block.type === 'code') {
      // A code block exports as its matching code-card image.
      image = (article.images ?? []).find((img) => img.kind === 'code-card' && img.codeId === block.codeId);
    }
    if (image && !seen.has(image.id)) {
      seen.add(image.id);
      ordered.push(image);
    }
  }
  // Any image never referenced by a block still belongs in the tray, at the end.
  for (const image of article.images ?? []) {
    if (!seen.has(image.id)) ordered.push(image);
  }
  return ordered;
}

function imageMarkerIndex(article: XArticleBody, imageId: string): number {
  return orderedImages(article).findIndex((image) => image.id === imageId) + 1;
}

// ---------------------------------------------------------------------------
// Inline markdown → HTML (a deliberately tiny subset: **bold**, *italic*,
// `code`, [text](url). Anything else is escaped and passed through.)
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inlineToHtml(text: string): string {
  return escapeHtml(text)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    // X has no inline-code style; bold is the closest thing that survives.
    .replace(/`([^`]+)`/g, '<strong>$1</strong>');
}

/**
 * HTML tuned for what the X Article editor keeps on paste.
 * Nothing exotic: h2/h3, p, ul/ol/li, blockquote, strong/em, a.
 */
export function buildXArticleHtml(article: XArticleBody): string {
  const parts: string[] = [];
  parts.push(`<h1>${escapeHtml(article.headline)}</h1>`);
  if (article.dek?.trim()) {
    parts.push(`<p><em>${inlineToHtml(article.dek.trim())}</em></p>`);
  }
  if (article.hook?.trim()) {
    parts.push(`<p>${inlineToHtml(article.hook.trim())}</p>`);
  }

  for (const block of article.blocks) {
    switch (block.type) {
      case 'h2':
        parts.push(`<h2>${inlineToHtml(block.text)}</h2>`);
        break;
      case 'h3':
        parts.push(`<h3>${inlineToHtml(block.text)}</h3>`);
        break;
      case 'p':
        parts.push(`<p>${inlineToHtml(block.text)}</p>`);
        break;
      case 'quote':
        parts.push(`<blockquote>${inlineToHtml(block.text)}</blockquote>`);
        break;
      case 'callout':
        parts.push(
          `<blockquote><strong>${block.tone === 'tip' ? 'Tip' : 'Gotcha'}:</strong> ${inlineToHtml(block.text)}</blockquote>`,
        );
        break;
      case 'list': {
        const tag = block.ordered ? 'ol' : 'ul';
        const items = block.items.map((item) => `<li>${inlineToHtml(item)}</li>`).join('');
        parts.push(`<${tag}>${items}</${tag}>`);
        break;
      }
      case 'code': {
        const code = (article.code ?? []).find((entry) => entry.id === block.codeId);
        if (!code) break;
        if (code.caption?.trim()) {
          parts.push(`<p><em>${inlineToHtml(code.caption.trim())}</em></p>`);
        }
        // Real code block first — it renders natively where supported. The
        // code-card image stays in the tray as the fallback.
        parts.push(
          `<pre><code class="language-${escapeHtml(code.lang || 'text')}">${escapeHtml(code.source)}</code></pre>`,
        );
        break;
      }
      case 'image': {
        const image = (article.images ?? []).find((img) => img.id === block.imageId);
        const n = imageMarkerIndex(article, block.imageId);
        const caption = image?.caption?.trim() || image?.alt?.trim() || 'image';
        parts.push(`<p><em>[Image ${n || '?'} — ${escapeHtml(caption)}]</em></p>`);
        break;
      }
      default:
        break;
    }
  }

  return parts.join('\n');
}

/** Markdown fallback — also what the "Copy markdown" button writes. */
export function buildXArticleMarkdown(article: XArticleBody): string {
  const parts: string[] = [`# ${article.headline}`];
  if (article.dek?.trim()) parts.push(`*${article.dek.trim()}*`);
  if (article.hook?.trim()) parts.push(article.hook.trim());

  for (const block of article.blocks) {
    switch (block.type) {
      case 'h2':
        parts.push(`## ${block.text}`);
        break;
      case 'h3':
        parts.push(`### ${block.text}`);
        break;
      case 'p':
        parts.push(block.text);
        break;
      case 'quote':
        parts.push(
          block.text
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n'),
        );
        break;
      case 'callout':
        parts.push(`> **${block.tone === 'tip' ? 'Tip' : 'Gotcha'}:** ${block.text}`);
        break;
      case 'list':
        parts.push(
          block.items
            .map((item, index) => (block.ordered ? `${index + 1}. ${item}` : `- ${item}`))
            .join('\n'),
        );
        break;
      case 'code': {
        const code = (article.code ?? []).find((entry) => entry.id === block.codeId);
        if (!code) break;
        const image = (article.images ?? []).find(
          (img) => img.kind === 'code-card' && img.codeId === block.codeId,
        );
        const n = image ? imageMarkerIndex(article, image.id) : 0;
        if (code.caption?.trim()) parts.push(`*${code.caption.trim()}*`);
        parts.push(`\`\`\`${code.lang || ''}\n${code.source}\n\`\`\``);
        if (n) parts.push(`_[Image ${n} — code card, use if the block pastes unstyled]_`);
        break;
      }
      case 'image': {
        const image = (article.images ?? []).find((img) => img.id === block.imageId);
        const n = imageMarkerIndex(article, block.imageId);
        parts.push(`_[Image ${n} — ${image?.caption || image?.alt || 'image'}]_`);
        break;
      }
      default:
        break;
    }
  }

  if (article.tags?.length) {
    parts.push(article.tags.map((tag) => `#${tag.replace(/^#/, '')}`).join(' '));
  }
  return parts.join('\n\n');
}

/** Plain-text flavor: markdown, minus fences that read as noise when pasted. */
export function buildXArticlePlainText(article: XArticleBody): string {
  return buildXArticleMarkdown(article);
}

export function buildPromoThreadText(article: XArticleBody): string {
  const tweets = article.promoThread ?? [];
  return tweets
    .map((tweet, index) => `${index + 1}/${tweets.length}\n${tweet}`)
    .join('\n\n---\n\n');
}

/**
 * Write both clipboard flavors. Falls back to plain text when the browser has
 * no async-clipboard `ClipboardItem` (Safari private mode, insecure origins).
 */
export async function copyArticleToClipboard(article: XArticleBody): Promise<'rich' | 'plain'> {
  const html = buildXArticleHtml(article);
  const text = buildXArticlePlainText(article);

  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        }),
      ]);
      return 'rich';
    } catch {
      // Fall through to the plain-text path below.
    }
  }

  await navigator.clipboard.writeText(text);
  return 'plain';
}

export function articleWordCount(article: XArticleBody): number {
  const text = article.blocks
    .map((block) => {
      if (block.type === 'list') return block.items.join(' ');
      if ('text' in block) return block.text;
      return '';
    })
    .join(' ');
  return text.split(/\s+/).filter(Boolean).length;
}
