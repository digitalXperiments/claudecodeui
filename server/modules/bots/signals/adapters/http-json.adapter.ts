import { secretsService } from '@/modules/secrets/index.js';
import {
  asString,
  fetchText,
  MAX_EVENTS_PER_POLL,
  validateHttpUrl,
  type WatchAdapter,
  type WatchEventDraft,
  type WatchFetch,
} from '@/modules/bots/signals/adapters/adapter.types.js';

const SEEN_CAP = 500;
const PAYLOAD_TEXT_CAP = 2000;

function getPath(value: unknown, dotted: string): unknown {
  if (!dotted) return value;
  let current: unknown = value;
  for (const part of dotted.split('.')) {
    if (current && typeof current === 'object') current = (current as Record<string, unknown>)[part];
    else return undefined;
  }
  return current;
}

function clip(item: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    out[key] = typeof value === 'string' && value.length > PAYLOAD_TEXT_CAP ? `${value.slice(0, PAYLOAD_TEXT_CAP)}…` : value;
  }
  return out;
}

export interface HttpJsonDeps {
  fetch?: WatchFetch;
  /** Resolves `${secret:NAME}` refs in header values. Defaults to the secrets vault. */
  resolveSecrets?: (headers: Record<string, string>) => Record<string, string>;
}

export function createHttpJsonAdapter(deps: HttpJsonDeps = {}): WatchAdapter {
  return {
    validate(config) {
      const urlError = validateHttpUrl(config.url);
      if (urlError) return urlError;
      if (!asString(config.id_field)) return 'id_field is required (the field that uniquely identifies each item)';
      if (config.headers !== undefined && (typeof config.headers !== 'object' || config.headers === null || Array.isArray(config.headers))) {
        return 'headers must be an object of header name to value';
      }
      return null;
    },
    async poll(config, cursor) {
      const url = asString(config.url);
      const idField = asString(config.id_field);
      const rawHeaders: Record<string, string> = {};
      for (const [name, value] of Object.entries((config.headers ?? {}) as Record<string, unknown>)) {
        if (typeof value === 'string') rawHeaders[name] = value;
      }
      const headers = deps.resolveSecrets
        ? deps.resolveSecrets(rawHeaders)
        : secretsService.resolveInObject(rawHeaders);
      const fetchImpl = deps.fetch ?? (globalThis.fetch as unknown as WatchFetch);
      let body: unknown;
      try {
        body = JSON.parse(await fetchText(fetchImpl, url, { accept: 'application/json', ...headers }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Never echo header values (they may be resolved secrets).
        throw new Error(message.replace(/\$\{secret:[^}]+\}/g, '<secret>'));
      }
      const list = getPath(body, asString(config.items_path));
      if (!Array.isArray(list)) throw new Error('response did not contain a JSON array at items_path');
      const previous = Array.isArray(cursor.seen) ? (cursor.seen as unknown[]).filter((v): v is string => typeof v === 'string') : [];
      const seen = new Set(previous);
      const initialized = cursor.initialized === true;
      const items = list.filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === 'object');
      const currentIds: string[] = [];
      const events: WatchEventDraft[] = [];
      for (const item of items) {
        const raw = getPath(item, idField);
        if (raw === undefined || raw === null || raw === '') continue;
        const id = String(raw);
        currentIds.push(id);
        if (seen.has(id)) continue;
        if (!initialized && config.emit_existing !== true) continue;
        if (events.length >= MAX_EVENTS_PER_POLL) continue;
        events.push({
          source: 'watch:http_json',
          kind: 'watch',
          dedupeKey: `http_json:${url}:${id}`,
          trust: 'external',
          payload: { adapter: 'http_json', url, id, item: clip(item) },
        });
      }
      const merged = [...currentIds, ...previous.filter((id) => !currentIds.includes(id))].slice(0, SEEN_CAP);
      return { events, cursor: { initialized: true, seen: merged } };
    },
  };
}
