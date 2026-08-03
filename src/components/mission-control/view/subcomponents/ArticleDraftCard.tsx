import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  FileText,
  Image as ImageIcon,
  Images,
  Layers,
  Lightbulb,
  Loader2,
  Quote as QuoteIcon,
  RefreshCw,
} from 'lucide-react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';

import { authenticatedFetch } from '../../../../utils/api';
import { copyTextToClipboard } from '../../../../utils/clipboard';
import { useTheme } from '../../../../contexts/ThemeContext';
import {
  articleWordCount,
  buildPromoThreadText,
  buildXArticleMarkdown,
  copyArticleToClipboard,
  orderedImages,
  type XArticleBody,
  type XArticleImage,
} from '../../utils/xArticle';

type Tab = 'preview' | 'markdown' | 'titles' | 'images' | 'thread' | 'sources';

type ArticleDraftCardProps = {
  article: XArticleBody;
  /** Renders images and enables the generate button only when the item is live. */
  itemId: string;
  onGenerateAssets: (force: boolean) => Promise<{ generated: number; skipped: number; failed: number; messages: string[] }>;
};

/**
 * Article-shaped renderer for Mission Control items whose body is an
 * `x_article`. The generic JSON view is useless for prose — this one shows the
 * draft the way it will read, and hands over exactly what x.com will accept:
 * rich text on the clipboard, images as files to drag in.
 */
export function ArticleDraftCard({ article, itemId, onGenerateAssets }: ArticleDraftCardProps) {
  const [tab, setTab] = useState<Tab>('preview');
  const [copied, setCopied] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [assetNote, setAssetNote] = useState<string | null>(null);

  const images = useMemo(() => orderedImages(article), [article]);
  const markdown = useMemo(() => buildXArticleMarkdown(article), [article]);
  const threadText = useMemo(() => buildPromoThreadText(article), [article]);
  const words = useMemo(() => articleWordCount(article), [article]);
  const pendingImages = images.filter((image) => image.status !== 'ready').length;

  const flash = useCallback((key: string) => {
    setCopied(key);
    window.setTimeout(() => setCopied((current) => (current === key ? null : current)), 1800);
  }, []);

  const handleCopyForX = useCallback(async () => {
    const mode = await copyArticleToClipboard(article);
    flash(mode === 'rich' ? 'x-rich' : 'x-plain');
  }, [article, flash]);

  const handleGenerate = useCallback(
    async (force: boolean) => {
      setGenerating(true);
      setAssetNote(null);
      try {
        const result = await onGenerateAssets(force);
        const parts = [`${result.generated} rendered`];
        if (result.skipped) parts.push(`${result.skipped} skipped`);
        if (result.failed) parts.push(`${result.failed} failed`);
        setAssetNote(
          [parts.join(', '), ...result.messages.slice(0, 3)].filter(Boolean).join(' · '),
        );
        setTab('images');
      } catch (error) {
        setAssetNote(error instanceof Error ? error.message : String(error));
      } finally {
        setGenerating(false);
      }
    },
    [onGenerateAssets],
  );

  return (
    <div className="mb-3 overflow-hidden rounded-lg border border-border bg-background">
      <div className="border-b border-border bg-muted/40 px-3 py-2.5">
        <h4 className="break-words text-sm font-semibold leading-snug text-foreground">
          {article.headline}
        </h4>
        {article.dek ? (
          <p className="mt-0.5 break-words text-xs text-muted-foreground">{article.dek}</p>
        ) : null}
        <p className="mt-1 text-[10px] text-muted-foreground/80">
          {words} words
          {article.readingMinutes ? ` · ${article.readingMinutes} min read` : ''}
          {` · ${images.length} image${images.length === 1 ? '' : 's'}`}
          {pendingImages > 0 ? ` (${pendingImages} not rendered)` : ''}
          {article.promoThread?.length ? ` · ${article.promoThread.length}-tweet thread` : ''}
        </p>

        <div className="mt-2 flex flex-wrap gap-1.5">
          <ToolbarButton
            onClick={handleCopyForX}
            active={copied === 'x-rich' || copied === 'x-plain'}
            icon={copied?.startsWith('x-') ? Check : Copy}
            label={
              copied === 'x-rich'
                ? 'Copied rich text'
                : copied === 'x-plain'
                  ? 'Copied plain text'
                  : 'Copy for X'
            }
            primary
          />
          <ToolbarButton
            onClick={async () => {
              await copyTextToClipboard(markdown);
              flash('md');
            }}
            active={copied === 'md'}
            icon={copied === 'md' ? Check : FileText}
            label={copied === 'md' ? 'Copied' : 'Copy markdown'}
          />
          {article.promoThread?.length ? (
            <ToolbarButton
              onClick={async () => {
                await copyTextToClipboard(threadText);
                flash('thread');
              }}
              active={copied === 'thread'}
              icon={copied === 'thread' ? Check : Layers}
              label={copied === 'thread' ? 'Copied' : 'Copy thread'}
            />
          ) : null}
          <ToolbarButton
            onClick={() => void handleGenerate(pendingImages === 0)}
            icon={generating ? Loader2 : pendingImages > 0 ? ImageIcon : RefreshCw}
            spinning={generating}
            label={
              generating
                ? 'Rendering…'
                : pendingImages > 0
                  ? `Render ${pendingImages} image${pendingImages === 1 ? '' : 's'}`
                  : 'Re-render images'
            }
          />
        </div>

        {assetNote ? (
          <p className="mt-1.5 break-words text-[10px] text-muted-foreground">{assetNote}</p>
        ) : null}

        <p className="mt-1.5 text-[10px] text-muted-foreground/70">
          Paste into the X article editor, then drag the numbered images into their
          <span className="font-medium"> [Image n] </span>
          markers — paste carries text and code, never images. Each snippet also ships
          as a code card you can drop in if a block pastes unstyled.
        </p>
      </div>

      <div className="flex gap-0.5 border-b border-border px-2 pt-1.5">
        {(
          [
            ['preview', 'Preview'],
            ['markdown', 'Markdown'],
            ...(article.titleVariants?.length
              ? ([['titles', `Titles (${article.titleVariants.length + 1})`]] as Array<[Tab, string]>)
              : []),
            ['images', `Images${images.length ? ` (${images.length})` : ''}`],
            ['thread', 'Thread'],
            ['sources', 'Sources'],
          ] as Array<[Tab, string]>
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`rounded-t-md px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
              tab === id
                ? 'bg-background text-foreground shadow-[inset_0_-2px_0_0_hsl(var(--primary))]'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="max-h-[28rem] overflow-auto p-3">
        {tab === 'preview' ? <ArticlePreview article={article} images={images} /> : null}
        {tab === 'markdown' ? (
          <pre className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-foreground/90">
            {markdown}
          </pre>
        ) : null}
        {tab === 'images' ? <ImageTray images={images} itemId={itemId} /> : null}
        {tab === 'thread' ? <PromoThread article={article} /> : null}
        {tab === 'sources' ? <SourcesTab article={article} /> : null}
        {tab === 'titles' ? <TitleOptions article={article} /> : null}
      </div>
    </div>
  );
}

function ToolbarButton({
  onClick,
  icon: Icon,
  label,
  active,
  primary,
  spinning,
}: {
  onClick: () => void | Promise<void>;
  icon: typeof Copy;
  label: string;
  active?: boolean;
  primary?: boolean;
  spinning?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => void onClick()}
      className={`inline-flex min-h-8 touch-manipulation items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
        active
          ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
          : primary
            ? 'bg-primary text-primary-foreground hover:opacity-90'
            : 'bg-muted text-foreground hover:bg-muted/70'
      }`}
    >
      <Icon className={`h-3 w-3 ${spinning ? 'animate-spin' : ''}`} />
      {label}
    </button>
  );
}

function ArticlePreview({ article, images }: { article: XArticleBody; images: XArticleImage[] }) {
  const { isDarkMode } = useTheme();
  const imageNumber = (id: string) => images.findIndex((image) => image.id === id) + 1;

  return (
    <div className="space-y-3 text-sm leading-relaxed text-foreground/90">
      {article.hook ? (
        <p className="border-l-2 border-primary/60 pl-3 text-[13px] font-medium">{article.hook}</p>
      ) : null}

      {article.blocks.map((block, index) => {
        switch (block.type) {
          case 'h2':
            return (
              <h2 key={index} className="pt-2 text-base font-semibold text-foreground">
                {block.text}
              </h2>
            );
          case 'h3':
            return (
              <h3 key={index} className="pt-1 text-sm font-semibold text-foreground">
                {block.text}
              </h3>
            );
          case 'p':
            return (
              <p key={index} className="break-words">
                {block.text}
              </p>
            );
          case 'quote':
            return (
              <blockquote
                key={index}
                className="flex gap-2 rounded-md bg-muted/50 p-2.5 text-[13px] italic"
              >
                <QuoteIcon className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
                <span>{block.text}</span>
              </blockquote>
            );
          case 'callout':
            return (
              <div
                key={index}
                className={`flex gap-2 rounded-md p-2.5 text-[13px] ${
                  block.tone === 'tip'
                    ? 'bg-sky-500/10 text-sky-900 dark:text-sky-200'
                    : 'bg-amber-500/10 text-amber-900 dark:text-amber-200'
                }`}
              >
                {block.tone === 'tip' ? (
                  <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                ) : (
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                )}
                <span>{block.text}</span>
              </div>
            );
          case 'list': {
            const List = block.ordered ? 'ol' : 'ul';
            return (
              <List
                key={index}
                className={`ml-4 space-y-1 ${block.ordered ? 'list-decimal' : 'list-disc'}`}
              >
                {block.items.map((item, i) => (
                  <li key={i} className="break-words">
                    {item}
                  </li>
                ))}
              </List>
            );
          }
          case 'code': {
            const code = (article.code ?? []).find((entry) => entry.id === block.codeId);
            if (!code) return null;
            const card = (article.images ?? []).find(
              (image) => image.kind === 'code-card' && image.codeId === block.codeId,
            );
            return (
              <div key={index}>
                {code.caption ? (
                  <p className="mb-1 text-[11px] text-muted-foreground">{code.caption}</p>
                ) : null}
                <SyntaxHighlighter
                  language={code.lang || 'text'}
                  style={isDarkMode ? oneDark : oneLight}
                  customStyle={{
                    margin: 0,
                    borderRadius: '0.5rem',
                    fontSize: '0.75rem',
                    padding: '0.75rem',
                    ...(isDarkMode ? {} : { background: 'hsl(var(--muted))' }),
                  }}
                >
                  {code.source}
                </SyntaxHighlighter>
                {card ? (
                  <p className="mt-1 text-[10px] text-muted-foreground/80">
                    Exports as Image {imageNumber(card.id)} — {card.status === 'ready' ? 'rendered' : 'not rendered yet'}
                  </p>
                ) : null}
              </div>
            );
          }
          case 'image': {
            const image = (article.images ?? []).find((img) => img.id === block.imageId);
            if (!image) return null;
            return <ArticleImage key={index} image={image} number={imageNumber(image.id)} />;
          }
          default:
            return null;
        }
      })}
    </div>
  );
}

/**
 * Loads an asset as a blob — a bare `<img src>` cannot carry the auth header
 * the assets route requires.
 */
function useAssetBlob(assetUrl: string | undefined): { src: string | null; failed: boolean } {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!assetUrl) {
      setSrc(null);
      setFailed(false);
      return;
    }
    let objectUrl: string | null = null;
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await authenticatedFetch(assetUrl, { signal: controller.signal });
        if (!response.ok) throw new Error(`status ${response.status}`);
        const blob = await response.blob();
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
        setFailed(false);
      } catch (error) {
        if ((error as Error)?.name === 'AbortError') return;
        setFailed(true);
        setSrc(null);
      }
    })();

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [assetUrl]);

  return { src, failed };
}

function ArticleImage({ image, number }: { image: XArticleImage; number: number }) {
  const { src, failed } = useAssetBlob(image.assetUrl);

  if (!image.assetUrl) {
    return (
      <div className="rounded-md border border-dashed border-border p-3 text-[11px] text-muted-foreground">
        Image {number} — {image.alt}
        <span className="block text-[10px] text-muted-foreground/70">
          {image.statusMessage || 'Not rendered yet. Use “Render images”.'}
        </span>
      </div>
    );
  }

  return (
    <figure className="space-y-1">
      {src ? (
        <img
          src={src}
          alt={image.alt}
          className="w-full rounded-md border border-border"
          loading="lazy"
        />
      ) : (
        <div className="flex h-24 items-center justify-center rounded-md border border-border text-[11px] text-muted-foreground">
          {failed ? 'Could not load asset' : 'Loading…'}
        </div>
      )}
      <figcaption className="text-[10px] text-muted-foreground">
        Image {number}
        {image.caption ? ` — ${image.caption}` : ''}
      </figcaption>
    </figure>
  );
}

function ImageTray({ images, itemId }: { images: XArticleImage[]; itemId: string }) {
  if (images.length === 0) {
    return <p className="text-xs text-muted-foreground">This draft has no images.</p>;
  }
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-muted-foreground">
        Drag these into the X editor in order — each one belongs at its
        <span className="font-medium"> [Image n] </span> marker.
      </p>
      {images.map((image, index) => (
        <ImageTrayRow key={image.id} image={image} number={index + 1} itemId={itemId} />
      ))}
    </div>
  );
}

function ImageTrayRow({
  image,
  number,
  itemId,
}: {
  image: XArticleImage;
  number: number;
  itemId: string;
}) {
  const { src } = useAssetBlob(image.assetUrl);
  const [copied, setCopied] = useState(false);

  const download = () => {
    if (!src) return;
    const anchor = document.createElement('a');
    anchor.href = src;
    anchor.download = `${itemId.slice(0, 8)}-image-${number}.png`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  };

  return (
    <div className="flex gap-2.5 rounded-md border border-border p-2">
      <div className="flex h-14 w-20 shrink-0 items-center justify-center overflow-hidden rounded bg-muted/50">
        {src ? (
          <img src={src} alt={image.alt} className="h-full w-full object-cover" />
        ) : (
          <Images className="h-4 w-4 text-muted-foreground" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-medium text-foreground">
          Image {number} · {image.kind === 'code-card' ? 'code card' : `screenshot ${image.route ?? ''}`}
        </p>
        <p className="break-words text-[10px] text-muted-foreground">{image.alt}</p>
        {image.status && image.status !== 'ready' ? (
          <p className="break-words text-[10px] text-amber-600 dark:text-amber-400">
            {image.status}: {image.statusMessage}
          </p>
        ) : null}
        <div className="mt-1 flex gap-2">
          <button
            type="button"
            disabled={!src}
            onClick={download}
            className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            <Download className="h-3 w-3" /> Download
          </button>
          <button
            type="button"
            onClick={async () => {
              await copyTextToClipboard(image.alt);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            }}
            className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />} Copy alt
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The chosen headline plus its runners-up. Swapping one in means editing the
 * body JSON — this view exists so the choice is visible without a re-run.
 */
function TitleOptions({ article }: { article: XArticleBody }) {
  const [copied, setCopied] = useState<string | null>(null);
  const options = [article.headline, ...(article.titleVariants ?? [])];

  return (
    <div className="space-y-2">
      {article.pitch ? (
        <p className="rounded-md bg-muted/50 p-2.5 text-[11px] italic text-muted-foreground">
          {article.pitch}
        </p>
      ) : null}
      {article.angle ? (
        <p className="text-[10px] uppercase text-muted-foreground">Angle: {article.angle}</p>
      ) : null}
      <ul className="space-y-1.5">
        {options.map((title, index) => (
          <li
            key={index}
            className="flex items-start justify-between gap-2 rounded-md border border-border p-2"
          >
            <div className="min-w-0">
              <p className="break-words text-[13px]">{title}</p>
              <p className="text-[10px] text-muted-foreground">
                {index === 0 ? 'chosen' : 'alternate'} · {title.length} chars
                {title.length > 70 ? ' — over 70' : ''}
              </p>
            </div>
            <button
              type="button"
              onClick={async () => {
                await copyTextToClipboard(title);
                setCopied(title);
                window.setTimeout(() => setCopied(null), 1500);
              }}
              className="shrink-0 text-muted-foreground hover:text-foreground"
              aria-label="Copy title"
            >
              {copied === title ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PromoThread({ article }: { article: XArticleBody }) {
  const tweets = article.promoThread ?? [];
  if (tweets.length === 0) {
    return <p className="text-xs text-muted-foreground">No promo thread on this draft.</p>;
  }
  return (
    <ol className="space-y-2">
      {tweets.map((tweet, index) => (
        <li key={index} className="rounded-md border border-border p-2.5">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] font-medium text-muted-foreground">
              {index + 1}/{tweets.length}
            </span>
            <span
              className={`text-[10px] ${tweet.length > 280 ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground/70'}`}
            >
              {tweet.length}/280
            </span>
          </div>
          <p className="whitespace-pre-wrap break-words text-[13px]">{tweet}</p>
        </li>
      ))}
    </ol>
  );
}

function SourcesTab({ article }: { article: XArticleBody }) {
  const sources = article.sources ?? [];
  const facts = article.factCheck ?? [];
  return (
    <div className="space-y-3 text-[11px]">
      <div>
        <p className="mb-1 font-medium uppercase text-muted-foreground">Vault sources</p>
        {sources.length === 0 ? (
          <p className="text-muted-foreground">
            No sources recorded — treat every claim in this draft as unverified.
          </p>
        ) : (
          <ul className="space-y-1">
            {sources.map((source, index) => (
              <li key={index} className="break-words">
                <code className="rounded bg-muted px-1 py-0.5">{source.note}</code>
                {source.why ? <span className="text-muted-foreground"> — {source.why}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <p className="mb-1 font-medium uppercase text-muted-foreground">Fact check</p>
        {facts.length === 0 ? (
          <p className="text-muted-foreground">No claims recorded.</p>
        ) : (
          <ul className="space-y-1.5">
            {facts.map((fact, index) => (
              <li key={index} className="break-words">
                {fact.claim}
                {fact.evidencePath ? (
                  <code className="ml-1 rounded bg-muted px-1 py-0.5 text-[10px]">
                    {fact.evidencePath}
                  </code>
                ) : (
                  <span className="ml-1 text-amber-600 dark:text-amber-400">no evidence</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {article.tags?.length ? (
        <p className="text-muted-foreground">{article.tags.map((tag) => `#${tag}`).join(' ')}</p>
      ) : null}
    </div>
  );
}

export default ArticleDraftCard;
