import {
  asString,
  fetchText,
  MAX_EVENTS_PER_POLL,
  validateHttpUrl,
  type WatchAdapter,
  type WatchEventDraft,
  type WatchFetch,
} from '@/modules/bots/signals/adapters/adapter.types.js';

const SEEN_CAP = 200;

export interface FeedItem {
  id: string;
  title: string;
  link: string;
  published: string;
  summary: string;
}

function decodeEntities(raw: string): string {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function stripTags(raw: string): string {
  return decodeEntities(raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function tagText(block: string, names: string[]): string {
  for (const name of names) {
    const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
    if (match) return decodeEntities(match[1]).trim();
  }
  return '';
}

function atomLink(block: string): string {
  const links = [...block.matchAll(/<link\b([^>]*?)\/?>/gi)];
  let fallback = '';
  for (const link of links) {
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(link[1])?.[1];
    if (!href) continue;
    const rel = /rel\s*=\s*["']([^"']+)["']/i.exec(link[1])?.[1];
    if (!rel || rel === 'alternate') return decodeEntities(href);
    fallback ||= decodeEntities(href);
  }
  return fallback;
}

/** Minimal, regex based RSS 2.0 / Atom parser. Tolerates CDATA, entities and namespaces. */
export function parseFeed(xml: string): FeedItem[] {
  const blocks = [
    ...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi),
    ...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi),
  ].map((m) => m[1]);
  const items: FeedItem[] = [];
  for (const block of blocks) {
    const title = stripTags(tagText(block, ['title']));
    const link = tagText(block, ['link']).replace(/<[^>]+>/g, '').trim() || atomLink(block);
    const id = tagText(block, ['guid', 'id']) || link || title;
    if (!id) continue;
    const published = tagText(block, ['pubDate', 'published', 'updated', 'dc:date']);
    const summary = stripTags(tagText(block, ['description', 'summary', 'content', 'content:encoded'])).slice(0, 500);
    items.push({ id, title, link, published, summary });
  }
  return items;
}

export function createRssAdapter(deps: { fetch?: WatchFetch } = {}): WatchAdapter {
  return {
    validate: (config) => validateHttpUrl(config.url),
    async poll(config, cursor) {
      const url = asString(config.url);
      const fetchImpl = deps.fetch ?? (globalThis.fetch as unknown as WatchFetch);
      const xml = await fetchText(fetchImpl, url, { accept: 'application/rss+xml, application/atom+xml, text/xml' });
      const items = parseFeed(xml);
      const previous = Array.isArray(cursor.seen) ? (cursor.seen as unknown[]).filter((v): v is string => typeof v === 'string') : [];
      const seen = new Set(previous);
      const initialized = cursor.initialized === true;
      const emitExisting = config.emit_existing === true;
      const fresh = items.filter((item) => !seen.has(item.id));
      const events: WatchEventDraft[] = [];
      if (initialized || emitExisting) {
        // Oldest first so the bot reads them in publication order.
        for (const item of fresh.slice(0, MAX_EVENTS_PER_POLL).reverse()) {
          events.push({
            source: 'watch:rss',
            kind: 'watch',
            dedupeKey: `rss:${url}:${item.id}`,
            trust: 'external',
            payload: { adapter: 'rss', feed: url, ...item },
          });
        }
      }
      const merged = [...items.map((i) => i.id), ...previous.filter((id) => !items.some((i) => i.id === id))].slice(0, SEEN_CAP);
      const latest = items.map((i) => i.published).filter(Boolean).sort().pop() ?? asString(cursor.latest);
      return { events, cursor: { initialized: true, seen: merged, latest } };
    },
  };
}
