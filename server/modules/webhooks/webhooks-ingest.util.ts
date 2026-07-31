import type { Request } from 'express';

import type { WebhookIngestPayload } from '@/modules/webhooks/webhooks.types.js';

function readString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function firstHeader(req: Request, name: string): string {
  const raw = req.headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0] ?? '';
  return typeof raw === 'string' ? raw : '';
}

/**
 * Extract API key from header or query (agent API compatible).
 * Precedence: x-api-key > Authorization Bearer > ?apiKey=
 */
export function extractApiKey(req: Request): string {
  const headerKey = firstHeader(req, 'x-api-key').trim();
  if (headerKey) return headerKey;

  const auth = firstHeader(req, 'authorization').trim();
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }

  const queryKey = readString(req.query.apiKey).trim();
  if (queryKey) return queryKey;

  return '';
}

/**
 * Merge body / query / headers into a normalized ingest payload.
 * Precedence: body > query > headers.
 */
export function parseIngestRequest(req: Request): WebhookIngestPayload {
  const body =
    req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : {};
  const query = (req.query ?? {}) as Record<string, unknown>;

  const source =
    readString(body.source).trim() ||
    readString(query.source).trim() ||
    firstHeader(req, 'x-webhook-source').trim();

  const text =
    readString(body.text) ||
    readString(body.content) ||
    readString(body.note) ||
    readString(query.text) ||
    readString(query.content) ||
    firstHeader(req, 'x-webhook-text');

  const title =
    readString(body.title).trim() ||
    readString(query.title).trim() ||
    '';

  let payload: unknown = body.payload !== undefined ? body.payload : undefined;
  if (payload === undefined && body.data !== undefined) {
    payload = body.data;
  }
  // If no explicit text/payload but body has other fields, treat body as payload.
  if (!text && payload === undefined) {
    const rest = { ...body };
    delete rest.source;
    delete rest.title;
    delete rest.meta;
    if (Object.keys(rest).length > 0) {
      payload = rest;
    }
  }

  const meta =
    body.meta && typeof body.meta === 'object' && !Array.isArray(body.meta)
      ? (body.meta as Record<string, unknown>)
      : {};

  const raw: Record<string, unknown> = {
    ...query,
    ...body,
  };

  // Coerce empty text from object payload for template convenience.
  const resolvedText =
    text ||
    (typeof payload === 'string'
      ? payload
      : payload != null
        ? JSON.stringify(payload, null, 2)
        : '');

  return {
    source,
    text: resolvedText,
    title,
    payload: payload ?? {},
    meta,
    raw,
  };
}

export function wantsWait(req: Request): boolean {
  const q = req.query?.wait;
  if (q === '1' || q === 'true' || q === 'yes') return true;
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    const w = (req.body as Record<string, unknown>).wait;
    if (w === true || w === 1 || w === '1' || w === 'true') return true;
  }
  return false;
}
