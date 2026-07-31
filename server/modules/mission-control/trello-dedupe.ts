/**
 * Canonical Trello identity for Mission Control + Kanban bridge dedupe.
 *
 * Produce agents sometimes emit the full card id (24-char hex) and sometimes
 * the shortLink (e.g. qRPZkLzF from trello.com/c/qRPZkLzF/...). Both refer to
 * the same card — without normalization, two MC items and two Kanban cards
 * get created for one Trello card.
 */

/** 24-char hex Trello card/object id. */
const FULL_ID_RE = /^[a-f0-9]{24}$/i;
/** Common shortLink shape used in trello.com/c/<shortLink>/... */
const SHORT_LINK_RE = /^[a-zA-Z0-9]{6,12}$/;

export function isTrelloFullId(value: string): boolean {
  return FULL_ID_RE.test(value.trim());
}

export function isTrelloShortLink(value: string): boolean {
  const v = value.trim();
  return SHORT_LINK_RE.test(v) && !isTrelloFullId(v);
}

/** Pull shortLink from trello.com/c/<shortLink> or /c/<shortLink>/... */
export function shortLinkFromTrelloUrl(url: string): string | null {
  const m = url.trim().match(/trello\.com\/c\/([a-zA-Z0-9]+)/i);
  return m?.[1] ?? null;
}

/**
 * Collect every known identifier for a card from draft/item fields.
 * Order is not significant; use {@link pickCanonicalTrelloId} for the key.
 */
export function collectTrelloCardRefs(input: {
  dedupeKey?: string | null;
  body?: Record<string, unknown> | null;
  source?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
}): string[] {
  const out = new Set<string>();
  const add = (raw: unknown) => {
    if (typeof raw !== 'string') return;
    const v = raw.trim();
    if (!v) return;
    // Strip common prefixes
    const stripped = v.replace(/^trello:card:/i, '').trim();
    if (stripped) out.add(stripped);
    const fromUrl = shortLinkFromTrelloUrl(v);
    if (fromUrl) out.add(fromUrl);
  };

  add(input.dedupeKey);
  const bags = [input.body, input.source, input.result];
  for (const bag of bags) {
    if (!bag) continue;
    add(bag.trelloCardId);
    add(bag.trello_card_id);
    add(bag.cardId);
    add(bag.card_id);
    add(bag.id);
    add(bag.ticket);
    add(bag.trelloShortLink);
    add(bag.trello_short_link);
    add(bag.shortLink);
    add(bag.short_link);
    add(bag.trelloUrl);
    add(bag.trello_url);
    add(bag.url);
    add(bag.link);
  }
  return [...out];
}

/** Prefer full 24-char id; else shortLink; else first ref. */
export function pickCanonicalTrelloId(refs: string[]): string | null {
  if (refs.length === 0) return null;
  const full = refs.find(isTrelloFullId);
  if (full) return full.toLowerCase();
  const short = refs.find(isTrelloShortLink);
  if (short) return short;
  return refs[0] ?? null;
}

export function trelloDedupeKey(canonicalId: string): string {
  return `trello:card:${canonicalId}`;
}

export type NormalizedTrelloDraft = {
  dedupeKey: string;
  body: Record<string, unknown>;
  source: Record<string, unknown>;
  refs: string[];
  /** True when we recognized this draft as Trello-sourced. */
  isTrello: boolean;
};

/**
 * Normalize a produce draft so dedupeKey is always trello:card:<canonicalId>
 * when any Trello identity is present. Non-Trello drafts pass through.
 */
export function normalizeTrelloDraftFields(input: {
  dedupeKey: string;
  body?: Record<string, unknown>;
  source?: Record<string, unknown>;
}): NormalizedTrelloDraft {
  const body = { ...(input.body ?? {}) };
  const source = { ...(input.source ?? {}) };
  const refs = collectTrelloCardRefs({
    dedupeKey: input.dedupeKey,
    body,
    source,
  });

  const looksTrello =
    refs.length > 0 &&
    (/^trello:card:/i.test(input.dedupeKey) ||
      typeof body.trelloCardId === 'string' ||
      typeof body.trelloUrl === 'string' ||
      (typeof body.url === 'string' && /trello\.com\/c\//i.test(body.url)) ||
      refs.some((r) => isTrelloFullId(r) || isTrelloShortLink(r)));

  if (!looksTrello) {
    return {
      dedupeKey: input.dedupeKey,
      body,
      source: { ...source, dedupeKey: input.dedupeKey },
      refs: [],
      isTrello: false,
    };
  }

  const canonical = pickCanonicalTrelloId(refs);
  if (!canonical) {
    return {
      dedupeKey: input.dedupeKey,
      body,
      source: { ...source, dedupeKey: input.dedupeKey },
      refs,
      isTrello: true,
    };
  }

  const key = trelloDedupeKey(canonical);
  if (isTrelloFullId(canonical)) {
    body.trelloCardId = canonical;
  } else if (!body.trelloCardId) {
    body.trelloCardId = canonical;
  }
  const short =
    refs.find(isTrelloShortLink) ??
    (typeof body.trelloUrl === 'string' ? shortLinkFromTrelloUrl(body.trelloUrl) : null) ??
    (typeof body.url === 'string' ? shortLinkFromTrelloUrl(body.url) : null);
  if (short) {
    body.trelloShortLink = short;
  }

  return {
    dedupeKey: key,
    body,
    source: {
      ...source,
      dedupeKey: key,
      trelloCardId: body.trelloCardId,
      ...(short ? { trelloShortLink: short } : {}),
    },
    refs: collectTrelloCardRefs({ dedupeKey: key, body, source }),
    isTrello: true,
  };
}

/** All dedupe_key strings that should match an existing row for these refs. */
export function trelloDedupeKeyAliases(refs: string[]): string[] {
  const keys = new Set<string>();
  for (const r of refs) {
    keys.add(trelloDedupeKey(r));
    keys.add(trelloDedupeKey(r.toLowerCase()));
  }
  return [...keys];
}
