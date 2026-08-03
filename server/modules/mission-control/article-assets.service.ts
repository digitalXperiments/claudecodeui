import { promises as fs } from 'node:fs';
import path from 'node:path';

import sharp from 'sharp';

import { ensureImageAssetsDir } from '@/modules/assets/index.js';
import { browserUseService } from '@/modules/browser-use/index.js';
import { X_ARTICLE_BODY_KIND } from '@/modules/mission-control/x-articles-seed.js';

/**
 * Renders the images an X article needs, because the X editor accepts neither
 * markdown nor code blocks — every snippet has to arrive as a picture.
 *
 * Two producers:
 * - `code-card`: snippet → syntax-highlighted SVG → PNG via sharp. Fully local
 *   and deterministic; no external service, no network.
 * - `screenshot`: a CloudCLI route captured through the existing browser-use
 *   runtime. Degrades to a skipped image when that runtime isn't installed.
 *
 * Everything lands in `~/.cloudcli/assets` and is served by the existing
 * `GET /api/assets/images/:filename` route.
 */

export type ArticleImageKind = 'code-card' | 'screenshot';

export type ArticleImageStatus = 'ready' | 'skipped' | 'failed';

export type ArticleCodeEntry = {
  id: string;
  lang: string;
  caption: string;
  source: string;
};

export type ArticleImageEntry = {
  id: string;
  kind: ArticleImageKind;
  codeId?: string;
  route?: string;
  alt: string;
  caption?: string;
  /** Set by this service. */
  assetUrl?: string;
  assetPath?: string;
  width?: number;
  height?: number;
  status?: ArticleImageStatus;
  statusMessage?: string;
};

export type GenerateArticleAssetsResult = {
  body: Record<string, unknown>;
  generated: number;
  skipped: number;
  failed: number;
  messages: string[];
};

// ---------------------------------------------------------------------------
// Code card rendering
// ---------------------------------------------------------------------------

/** Dark card that reads well on both X themes. */
const CARD = {
  background: '#0d1117',
  chrome: '#161b22',
  border: '#2d333b',
  text: '#c9d1d9',
  caption: '#8b949e',
  keyword: '#ff7b72',
  string: '#a5d6ff',
  comment: '#8b949e',
  number: '#79c0ff',
  fn: '#d2a8ff',
  fontSize: 15,
  lineHeight: 24,
  padX: 24,
  padY: 20,
  chromeHeight: 40,
  /** Monospace advance width ratio; Menlo/DejaVu Sans Mono are both ~0.6em. */
  charWidth: 0.601,
  maxCols: 96,
  minWidth: 680,
  maxWidth: 1400,
} as const;

const KEYWORDS: Record<string, string[]> = {
  ts: ['import', 'from', 'export', 'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'await', 'async', 'type', 'interface', 'class', 'extends', 'implements', 'new', 'try', 'catch', 'finally', 'throw', 'typeof', 'as', 'null', 'undefined', 'true', 'false', 'void', 'this', 'switch', 'case', 'break', 'continue', 'default', 'satisfies'],
  bash: ['if', 'then', 'else', 'fi', 'for', 'in', 'do', 'done', 'while', 'case', 'esac', 'function', 'export', 'local', 'return', 'echo', 'cd', 'sudo', 'npm', 'npx', 'node', 'git'],
  json: ['true', 'false', 'null'],
  sql: ['SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT', 'INNER', 'GROUP', 'ORDER', 'BY', 'LIMIT', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE', 'TABLE', 'AS', 'ON', 'AND', 'OR', 'NOT', 'NULL'],
};

function keywordsFor(lang: string): string[] {
  const normalized = lang.toLowerCase();
  if (normalized === 'tsx' || normalized === 'js' || normalized === 'jsx' || normalized === 'javascript' || normalized === 'typescript') {
    return KEYWORDS.ts;
  }
  if (normalized === 'sh' || normalized === 'shell' || normalized === 'zsh' || normalized === 'console') {
    return KEYWORDS.bash;
  }
  return KEYWORDS[normalized] ?? [];
}

function lineCommentPrefix(lang: string): string | null {
  const normalized = lang.toLowerCase();
  if (['bash', 'sh', 'shell', 'zsh', 'console', 'yaml', 'yml', 'python', 'py', 'toml'].includes(normalized)) {
    return '#';
  }
  if (['sql'].includes(normalized)) return '--';
  if (['json', 'text', 'txt', ''].includes(normalized)) return null;
  return '//';
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

type Token = { text: string; color: string };

/**
 * Deliberately small highlighter: strings, comments, numbers, keywords, call
 * names. A full tokenizer would be a dependency and a maintenance burden for
 * something that only has to look right at a glance in a screenshot.
 */
function tokenizeLine(line: string, lang: string): Token[] {
  const comment = lineCommentPrefix(lang);
  if (comment) {
    const idx = findCommentStart(line, comment);
    if (idx >= 0) {
      const before = line.slice(0, idx);
      return [...tokenizeLine(before, lang), { text: line.slice(idx), color: CARD.comment }];
    }
  }

  const tokens: Token[] = [];
  const keywords = keywordsFor(lang);
  // Order matters: strings first so keywords inside them are not recoloured.
  const pattern = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|([^\w$"'`]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    const [raw, str, num, word] = match;
    if (str) {
      tokens.push({ text: str, color: CARD.string });
    } else if (num) {
      tokens.push({ text: num, color: CARD.number });
    } else if (word) {
      const isKeyword = keywords.includes(word) || keywords.includes(word.toUpperCase());
      const isCall = line[pattern.lastIndex] === '(';
      tokens.push({
        text: word,
        color: isKeyword ? CARD.keyword : isCall ? CARD.fn : CARD.text,
      });
    } else {
      tokens.push({ text: raw, color: CARD.text });
    }
  }
  return tokens;
}

/** Find a comment marker that isn't inside a string literal. */
function findCommentStart(line: string, marker: string): number {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (line.startsWith(marker, i)) {
      // `//` inside a URL is not a comment.
      if (marker === '//' && i > 0 && line[i - 1] === ':') continue;
      return i;
    }
  }
  return -1;
}

export type CodeCardSvg = { svg: string; width: number; height: number };

/** Build the card SVG. Exported so tests can assert layout without rasterizing. */
export function buildCodeCardSvg(entry: Pick<ArticleCodeEntry, 'lang' | 'caption' | 'source'>): CodeCardSvg {
  const lines = entry.source
    .replace(/\t/g, '  ')
    .split('\n')
    // Trailing blank lines only add dead space to the card.
    .reduce<string[]>((acc, line) => {
      acc.push(line);
      return acc;
    }, [])
    .map((line) => (line.length > CARD.maxCols ? `${line.slice(0, CARD.maxCols - 1)}…` : line));
  while (lines.length > 1 && lines[lines.length - 1].trim() === '') lines.pop();
  while (lines.length > 1 && lines[0].trim() === '') lines.shift();

  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
  const contentWidth = Math.ceil(longest * CARD.fontSize * CARD.charWidth);
  const width = Math.min(
    CARD.maxWidth,
    Math.max(CARD.minWidth, contentWidth + CARD.padX * 2),
  );
  const height = CARD.chromeHeight + CARD.padY * 2 + lines.length * CARD.lineHeight;

  const rows = lines
    .map((line, index) => {
      const y = CARD.chromeHeight + CARD.padY + CARD.lineHeight * index + CARD.fontSize;
      const tokens = tokenizeLine(line, entry.lang);
      if (tokens.length === 0) return '';
      // xml:space="preserve" keeps leading indentation, which is half the point
      // of showing code at all.
      const spans = tokens
        .map((token) => `<tspan fill="${token.color}">${escapeXml(token.text)}</tspan>`)
        .join('');
      return `<text x="${CARD.padX}" y="${y}" xml:space="preserve">${spans}</text>`;
    })
    .join('\n    ');

  const caption = entry.caption?.trim()
    ? `<text x="${CARD.padX}" y="26" font-size="13" fill="${CARD.caption}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">${escapeXml(entry.caption.trim())}</text>`
    : '';
  const langBadge = `<text x="${width - CARD.padX}" y="26" font-size="12" text-anchor="end" fill="${CARD.caption}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">${escapeXml(entry.lang || 'text')}</text>`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" rx="12" fill="${CARD.background}" stroke="${CARD.border}" stroke-width="1"/>
  <rect width="${width}" height="${CARD.chromeHeight}" rx="12" fill="${CARD.chrome}"/>
  <rect y="${CARD.chromeHeight - 12}" width="${width}" height="12" fill="${CARD.chrome}"/>
  <line x1="0" y1="${CARD.chromeHeight}" x2="${width}" y2="${CARD.chromeHeight}" stroke="${CARD.border}" stroke-width="1"/>
  ${caption}
  ${langBadge}
  <g font-family="Menlo, 'SF Mono', 'DejaVu Sans Mono', Consolas, monospace" font-size="${CARD.fontSize}" fill="${CARD.text}">
    ${rows}
  </g>
</svg>`;

  return { svg, width, height };
}

/** Rasterize a code card at 2x for a crisp upload. */
export async function renderCodeCardPng(
  entry: Pick<ArticleCodeEntry, 'lang' | 'caption' | 'source'>,
): Promise<{ buffer: Buffer; width: number; height: number }> {
  const { svg, width, height } = buildCodeCardSvg(entry);
  const buffer = await sharp(Buffer.from(svg), { density: 144 })
    .resize({ width: width * 2, height: height * 2, fit: 'fill' })
    .png({ compressionLevel: 9 })
    .toBuffer();
  return { buffer, width: width * 2, height: height * 2 };
}

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------

function localAppOrigin(): string {
  const port = process.env.PORT || process.env.CLOUDCLI_PORT || '3001';
  return `http://127.0.0.1:${port}`;
}

function normalizeRoute(route: string): string {
  const trimmed = route.trim();
  if (!trimmed) return '/';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/**
 * Capture a CloudCLI route through the shared browser runtime.
 *
 * The runtime is optional (playwright + chromium are installed on demand), so
 * a missing runtime is a `skipped` image with an actionable message, never a
 * failed asset run.
 */
export async function captureRouteScreenshot(
  route: string,
): Promise<{ buffer: Buffer; width: number; height: number } | { skipped: string }> {
  const status = await browserUseService.getStatus();
  if (!status.available) {
    return { skipped: status.message || 'Browser runtime is not available.' };
  }

  const target = normalizeRoute(route);
  const url = /^https?:\/\//i.test(target) ? target : `${localAppOrigin()}${target}`;

  let sessionId: string | null = null;
  try {
    const session = await browserUseService.createAgentSession();
    sessionId = session.id;
    if (session.status !== 'ready') {
      return { skipped: session.message || 'Browser session could not start.' };
    }
    await browserUseService.agentNavigate(sessionId, url);
    const png = await browserUseService.agentCapturePng(sessionId);
    const meta = await sharp(png).metadata();
    return { buffer: png, width: meta.width ?? 0, height: meta.height ?? 0 };
  } finally {
    if (sessionId) {
      await browserUseService.agentStopSession(sessionId).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'article';
}

async function writeAsset(prefix: string, id: string, buffer: Buffer): Promise<{ filename: string; filePath: string }> {
  const assetsDir = await ensureImageAssetsDir();
  const filename = `${prefix}-${slugify(id)}-${Date.now()}.png`;
  const filePath = path.join(assetsDir, filename);
  await fs.writeFile(filePath, buffer);
  return { filename, filePath };
}

function readEntries<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * Generate every missing image for an article body and return the patched body.
 * Idempotent: images that already have a `ready` asset are left alone unless
 * `force` is set.
 */
export async function generateArticleAssets(
  body: Record<string, unknown>,
  options: { force?: boolean; slug?: string } = {},
): Promise<GenerateArticleAssetsResult> {
  if (body?.kind !== X_ARTICLE_BODY_KIND) {
    throw new Error(`Body is not an ${X_ARTICLE_BODY_KIND} (got kind="${String(body?.kind)}")`);
  }

  const codeEntries = readEntries<ArticleCodeEntry>(body.code);
  const images = readEntries<ArticleImageEntry>(body.images);
  const prefix = slugify(options.slug || String(body.slug ?? 'article'));

  const messages: string[] = [];
  let generated = 0;
  let skipped = 0;
  let failed = 0;

  const nextImages: ArticleImageEntry[] = [];
  for (const image of images) {
    if (!options.force && image.status === 'ready' && image.assetUrl) {
      nextImages.push(image);
      continue;
    }

    try {
      if (image.kind === 'code-card') {
        const code = codeEntries.find((entry) => entry.id === image.codeId);
        if (!code) {
          failed++;
          messages.push(`${image.id}: no code entry "${image.codeId}"`);
          nextImages.push({ ...image, status: 'failed', statusMessage: `Unknown codeId "${image.codeId}"` });
          continue;
        }
        const png = await renderCodeCardPng(code);
        const { filename, filePath } = await writeAsset(prefix, image.id, png.buffer);
        generated++;
        nextImages.push({
          ...image,
          assetUrl: `/api/assets/images/${filename}`,
          assetPath: filePath,
          width: png.width,
          height: png.height,
          status: 'ready',
          statusMessage: undefined,
        });
        continue;
      }

      if (image.kind === 'screenshot') {
        const shot = await captureRouteScreenshot(image.route ?? '/');
        if ('skipped' in shot) {
          skipped++;
          messages.push(`${image.id}: ${shot.skipped}`);
          nextImages.push({ ...image, status: 'skipped', statusMessage: shot.skipped });
          continue;
        }
        const { filename, filePath } = await writeAsset(prefix, image.id, shot.buffer);
        generated++;
        nextImages.push({
          ...image,
          assetUrl: `/api/assets/images/${filename}`,
          assetPath: filePath,
          width: shot.width,
          height: shot.height,
          status: 'ready',
          statusMessage: undefined,
        });
        continue;
      }

      skipped++;
      messages.push(`${image.id}: unsupported kind "${String(image.kind)}"`);
      nextImages.push({ ...image, status: 'skipped', statusMessage: `Unsupported kind "${String(image.kind)}"` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed++;
      messages.push(`${image.id}: ${message}`);
      nextImages.push({ ...image, status: 'failed', statusMessage: message });
    }
  }

  return {
    body: { ...body, images: nextImages },
    generated,
    skipped,
    failed,
    messages,
  };
}
