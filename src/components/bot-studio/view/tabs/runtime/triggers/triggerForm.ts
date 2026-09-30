/**
 * Pure logic for the Triggers tab: editable kinds, the form draft, draft <-> config conversion,
 * client-side validation that mirrors server/modules/bots/signals/triggers.service.ts, and the
 * one-line summaries shown in the list. No React here so it can run under `node --test`.
 */

import type { BotEvent, BotTrigger } from '../../../../types/botRuntime';
import { validateCron } from '../../../detail/cron';

export const EDITABLE_KINDS = [
  'cron', 'nl_schedule', 'interval', 'webhook', 'watch', 'run_completed', 'kanban_event', 'interrupt_created',
] as const;
export type EditableKind = (typeof EDITABLE_KINDS)[number];

export const isEditableKind = (kind: string): kind is EditableKind => (EDITABLE_KINDS as readonly string[]).includes(kind);

export const KIND_LABELS: Record<string, string> = {
  cron: 'Cron schedule',
  nl_schedule: 'Plain-language schedule',
  interval: 'Interval',
  webhook: 'Webhook',
  watch: 'Watch',
  run_completed: 'Run completed',
  kanban_event: 'Board event',
  interrupt_created: 'Interrupt created',
  peer_message: 'Peer message',
  ask_bot: 'Ask bot',
  commitment_due: 'Commitment due',
  operator_message: 'Operator message',
  manual: 'Manual wake',
};

export const KIND_HINTS: Record<EditableKind, string> = {
  cron: 'A five-field cron expression, evaluated in the timezone you pick.',
  nl_schedule: 'Type a schedule in plain words; it compiles to cron and the result is shown for confirmation.',
  interval: 'Wake on a fixed interval (at least one minute).',
  webhook: 'An external system POSTs signed events to a per-trigger URL.',
  watch: 'A cheap poller that wakes the bot only when something changed.',
  run_completed: 'Wake when a run finishes.',
  kanban_event: 'Wake on a board event.',
  interrupt_created: 'Wake when an approval or question is raised.',
};

export const WATCH_ADAPTERS = ['rss', 'directory', 'github', 'http_json'] as const;
export type WatchAdapterKind = (typeof WATCH_ADAPTERS)[number];

export const WATCH_ADAPTER_LABELS: Record<WatchAdapterKind, string> = {
  rss: 'RSS / Atom feed',
  directory: 'Directory',
  github: 'GitHub repository',
  http_json: 'HTTP JSON endpoint',
};

export const GITHUB_WHAT = ['issues', 'pulls', 'notifications'] as const;

export const MIN_INTERVAL_S = 60;
export const DEFAULT_WATCH_INTERVAL_S = 300;
export const MAX_COALESCE_MS = 600_000;
export const DEFAULT_COALESCE_MS = 5_000;

export type IntervalUnit = 'minutes' | 'hours' | 'days';
const UNIT_SECONDS: Record<IntervalUnit, number> = { minutes: 60, hours: 3_600, days: 86_400 };

export function toSeconds(value: string, unit: IntervalUnit): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * UNIT_SECONDS[unit]) : Number.NaN;
}

/** The largest unit that divides `seconds` evenly (falls back to minutes with a fractional value). */
export function fromSeconds(seconds: number): { value: string; unit: IntervalUnit } {
  if (!Number.isFinite(seconds) || seconds <= 0) return { value: '', unit: 'minutes' };
  for (const unit of ['days', 'hours', 'minutes'] as const) {
    if (seconds % UNIT_SECONDS[unit] === 0) return { value: String(seconds / UNIT_SECONDS[unit]), unit };
  }
  return { value: String(Math.round((seconds / 60) * 100) / 100), unit: 'minutes' };
}

export function formatEvery(seconds: number): string {
  const { value, unit } = fromSeconds(seconds);
  if (!value) return `${seconds}s`;
  return `${value} ${Number(value) === 1 ? unit.slice(0, -1) : unit}`;
}

// ---- draft ---------------------------------------------------------------------------------

export type TriggerDraft = {
  kind: EditableKind;
  enabled: boolean;
  // schedules
  cron: string;
  timezone: string;
  text: string;
  everyValue: string;
  everyUnit: IntervalUnit;
  // webhook
  secretRef: string;
  // watch
  adapter: WatchAdapterKind;
  watchIntervalValue: string;
  watchIntervalUnit: IntervalUnit;
  emitExisting: boolean;
  url: string;
  path: string;
  pattern: string;
  includeHidden: boolean;
  repo: string;
  what: string[];
  idField: string;
  itemsPath: string;
  headerName: string;
  headerSecret: string;
  headerPrefix: '' | 'Bearer ';
  /** Headers that are not the single managed secret header; preserved untouched on edit. */
  extraHeaders: Record<string, string>;
  // automation filters
  status: string;
  source: string;
  projectId: string;
  event: string;
  interruptKind: string;
  severity: string;
  allowBotOrigin: boolean;
  coalesceMs: string;
};

export function emptyDraft(kind: EditableKind = 'cron'): TriggerDraft {
  return {
    kind,
    enabled: true,
    cron: '0 9 * * 1-5',
    timezone: '',
    text: '',
    everyValue: '15',
    everyUnit: 'minutes',
    secretRef: '',
    adapter: 'rss',
    watchIntervalValue: '5',
    watchIntervalUnit: 'minutes',
    emitExisting: false,
    url: '',
    path: '',
    pattern: '',
    includeHidden: false,
    repo: '',
    what: ['issues', 'pulls'],
    idField: '',
    itemsPath: '',
    headerName: '',
    headerSecret: '',
    headerPrefix: '',
    extraHeaders: {},
    status: '',
    source: '',
    projectId: '',
    event: '',
    interruptKind: '',
    severity: '',
    allowBotOrigin: false,
    coalesceMs: '',
  };
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number => (typeof value === 'number' ? value : Number(value));

const SECRET_HEADER = /^(Bearer )?\$\{secret:([^}]+)\}$/;

/** Split `headers` into the first `Name: [Bearer ]${secret:REF}` pair (editable) and the rest (preserved). */
export function splitHeaders(headers: unknown): { name: string; secret: string; prefix: '' | 'Bearer '; extra: Record<string, string> } {
  const out = { name: '', secret: '', prefix: '' as '' | 'Bearer ', extra: {} as Record<string, string> };
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return out;
  for (const [name, raw] of Object.entries(headers as Record<string, unknown>)) {
    const value = str(raw);
    const match = !out.name ? SECRET_HEADER.exec(value) : null;
    if (match) {
      out.name = name;
      out.secret = match[2];
      out.prefix = match[1] ? 'Bearer ' : '';
    } else {
      out.extra[name] = value;
    }
  }
  return out;
}

export function draftFromTrigger(trigger: BotTrigger): TriggerDraft {
  const config = trigger.config ?? {};
  const kind: EditableKind = isEditableKind(trigger.kind) ? trigger.kind : 'cron';
  const draft = emptyDraft(kind);
  draft.enabled = trigger.enabled;
  draft.cron = str(config.cron);
  draft.timezone = str(config.timezone);
  draft.text = str(config.text);
  if (kind === 'interval') {
    const every = fromSeconds(num(config.every_s));
    draft.everyValue = every.value;
    draft.everyUnit = every.unit;
  }
  draft.secretRef = str(config.secret_ref);
  const adapter = str(config.adapter);
  draft.adapter = (WATCH_ADAPTERS as readonly string[]).includes(adapter) ? (adapter as WatchAdapterKind) : 'rss';
  const watchEvery = fromSeconds(num(config.interval_s) || DEFAULT_WATCH_INTERVAL_S);
  draft.watchIntervalValue = watchEvery.value;
  draft.watchIntervalUnit = watchEvery.unit;
  draft.emitExisting = config.emit_existing === true;
  draft.url = str(config.url);
  draft.path = str(config.path);
  draft.pattern = str(config.pattern);
  draft.includeHidden = config.include_hidden === true;
  draft.repo = str(config.repo);
  draft.what = Array.isArray(config.what) ? config.what.map(String) : ['issues', 'pulls'];
  draft.idField = str(config.id_field);
  draft.itemsPath = str(config.items_path);
  const headers = splitHeaders(config.headers);
  draft.headerName = headers.name;
  draft.headerSecret = headers.secret;
  draft.headerPrefix = headers.prefix;
  draft.extraHeaders = headers.extra;
  draft.status = str(config.status);
  draft.source = str(config.source);
  draft.projectId = str(config.project_id);
  draft.event = str(config.event);
  draft.interruptKind = str(config.kind);
  draft.severity = str(config.severity);
  draft.allowBotOrigin = config.allow_bot_origin === true;
  draft.coalesceMs = config.coalesce_ms === undefined ? '' : String(config.coalesce_ms);
  return draft;
}

/** Config keys this form owns per kind; everything else in an existing config is preserved on edit. */
const MANAGED_KEYS: Record<EditableKind, string[]> = {
  cron: ['cron', 'timezone'],
  nl_schedule: ['text', 'timezone', 'compiled'],
  interval: ['every_s'],
  webhook: ['secret_ref'],
  watch: ['adapter', 'interval_s', 'emit_existing', 'url', 'path', 'pattern', 'include_hidden', 'repo', 'what', 'id_field', 'items_path', 'headers'],
  run_completed: ['status', 'source', 'project_id', 'allow_bot_origin'],
  kanban_event: ['event', 'project_id', 'allow_bot_origin'],
  interrupt_created: ['kind', 'severity', 'allow_bot_origin'],
};
const COMMON_KEYS = ['coalesce_ms'];

const setIf = (target: Record<string, unknown>, key: string, value: string): void => {
  const trimmed = value.trim();
  if (trimmed) target[key] = trimmed;
};

/** Build only the managed part of the config from a draft. */
export function configFromDraft(draft: TriggerDraft): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  switch (draft.kind) {
    case 'cron':
      setIf(config, 'cron', draft.cron);
      setIf(config, 'timezone', draft.timezone);
      break;
    case 'nl_schedule':
      setIf(config, 'text', draft.text);
      setIf(config, 'timezone', draft.timezone);
      break;
    case 'interval':
      config.every_s = toSeconds(draft.everyValue, draft.everyUnit);
      break;
    case 'webhook':
      setIf(config, 'secret_ref', draft.secretRef);
      break;
    case 'watch': {
      config.adapter = draft.adapter;
      config.interval_s = toSeconds(draft.watchIntervalValue, draft.watchIntervalUnit);
      if (draft.emitExisting) config.emit_existing = true;
      if (draft.adapter === 'rss') setIf(config, 'url', draft.url);
      if (draft.adapter === 'directory') {
        setIf(config, 'path', draft.path);
        setIf(config, 'pattern', draft.pattern);
        if (draft.includeHidden) config.include_hidden = true;
      }
      if (draft.adapter === 'github') {
        setIf(config, 'repo', draft.repo);
        config.what = draft.what;
      }
      if (draft.adapter === 'http_json') {
        setIf(config, 'url', draft.url);
        setIf(config, 'id_field', draft.idField);
        setIf(config, 'items_path', draft.itemsPath);
        const headers: Record<string, string> = { ...draft.extraHeaders };
        if (draft.headerName.trim() && draft.headerSecret.trim()) {
          headers[draft.headerName.trim()] = `${draft.headerPrefix}\${secret:${draft.headerSecret.trim()}}`;
        }
        if (Object.keys(headers).length > 0) config.headers = headers;
      }
      break;
    }
    case 'run_completed':
      setIf(config, 'status', draft.status);
      setIf(config, 'source', draft.source);
      setIf(config, 'project_id', draft.projectId);
      if (draft.allowBotOrigin) config.allow_bot_origin = true;
      break;
    case 'kanban_event':
      setIf(config, 'event', draft.event);
      setIf(config, 'project_id', draft.projectId);
      if (draft.allowBotOrigin) config.allow_bot_origin = true;
      break;
    case 'interrupt_created':
      setIf(config, 'kind', draft.interruptKind);
      setIf(config, 'severity', draft.severity);
      if (draft.allowBotOrigin) config.allow_bot_origin = true;
      break;
  }
  if (draft.coalesceMs.trim() !== '') config.coalesce_ms = Number(draft.coalesceMs);
  return config;
}

/** The config to send on create/update: the original minus the keys this form manages, plus the draft's. */
export function mergeConfig(original: Record<string, unknown> | null, draft: TriggerDraft): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(original ?? {}) };
  for (const key of [...MANAGED_KEYS[draft.kind], ...COMMON_KEYS]) delete merged[key];
  return { ...merged, ...configFromDraft(draft) };
}

// ---- validation ----------------------------------------------------------------------------

const TCC_PATH = /^(?:~|\/Users\/[^/]+|\/home\/[^/]+)\/(Documents|Desktop|Downloads)(?:\/|$)/i;

/** The macOS protected folder a directory path points into, or null. */
export function tccFolder(path: string): string | null {
  const match = TCC_PATH.exec(path.trim());
  return match ? match[1][0].toUpperCase() + match[1].slice(1).toLowerCase() : null;
}

const REPO_PATTERN = /^(?!.*\.\.)(?!\.\/)(?!.*\/\.$)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function validateInterval(value: string, unit: IntervalUnit, label: string): string | null {
  const seconds = toSeconds(value, unit);
  if (!Number.isFinite(seconds)) return `${label} is required.`;
  if (seconds < MIN_INTERVAL_S) return `${label} must be at least 1 minute.`;
  return null;
}

/** Null when the draft is acceptable. Mirrors the server so most mistakes show before saving. */
export function validateDraft(draft: TriggerDraft): string | null {
  switch (draft.kind) {
    case 'cron': {
      if (!draft.cron.trim()) return 'Enter a cron expression.';
      const error = validateCron(draft.cron);
      if (error) return error;
      break;
    }
    case 'nl_schedule':
      if (!draft.text.trim()) return 'Describe the schedule, for example "weekdays at 9am".';
      break;
    case 'interval': {
      const error = validateInterval(draft.everyValue, draft.everyUnit, 'Interval');
      if (error) return error;
      break;
    }
    case 'webhook':
      if (!draft.secretRef.trim()) return 'Enter the name of the secret used to sign this webhook.';
      break;
    case 'watch': {
      const error = validateInterval(draft.watchIntervalValue, draft.watchIntervalUnit, 'Poll interval');
      if (error) return error;
      if (draft.adapter === 'rss' && !isHttpUrl(draft.url)) return 'Enter the feed URL (http or https).';
      if (draft.adapter === 'directory') {
        if (!draft.path.trim()) return 'Enter the directory path.';
        const folder = tccFolder(draft.path);
        if (folder) return `The server cannot read ~/${folder} (macOS privacy protection). Use a folder outside Documents, Desktop and Downloads.`;
        if (draft.pattern.trim()) {
          try {
            new RegExp(draft.pattern);
          } catch {
            return 'The filename pattern is not a valid regular expression.';
          }
        }
      }
      if (draft.adapter === 'github') {
        if (!REPO_PATTERN.test(draft.repo.trim())) return 'Repository must look like owner/name.';
        if (draft.what.length === 0) return 'Pick at least one thing to watch.';
      }
      if (draft.adapter === 'http_json') {
        if (!isHttpUrl(draft.url)) return 'Enter the endpoint URL (http or https).';
        if (!draft.idField.trim()) return 'Enter the id field that uniquely identifies each item.';
        if (Boolean(draft.headerName.trim()) !== Boolean(draft.headerSecret.trim())) return 'Set both the header name and its secret, or neither.';
      }
      break;
    }
    default:
      break;
  }
  if (draft.coalesceMs.trim() !== '') {
    const n = Number(draft.coalesceMs);
    if (!Number.isFinite(n) || n < 0 || n > MAX_COALESCE_MS) return `Coalesce window must be between 0 and ${MAX_COALESCE_MS} ms.`;
  }
  return null;
}

// ---- summaries -----------------------------------------------------------------------------

const clip = (value: string, max = 60): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

const filterParts = (pairs: Array<[string, unknown]>): string =>
  pairs.filter(([, v]) => typeof v === 'string' && v.trim()).map(([k, v]) => `${k} ${String(v)}`).join(' · ');

/** One line describing what a trigger waits for. */
export function summarizeTrigger(trigger: Pick<BotTrigger, 'kind' | 'config'>): string {
  const c = trigger.config ?? {};
  switch (trigger.kind) {
    case 'cron':
      return `${str(c.cron) || 'no expression'}${str(c.timezone) ? ` (${str(c.timezone)})` : ''}${c.mirrored_from === 'schedule_cron' ? ' · mirrors the bot schedule' : ''}`;
    case 'nl_schedule': {
      const compiled = (c.compiled ?? {}) as { description?: string; cron?: string };
      return `${clip(str(c.text), 50)}${compiled.description ? ` → ${compiled.description}` : compiled.cron ? ` → ${compiled.cron}` : ''}`;
    }
    case 'interval':
      return `Every ${formatEvery(num(c.every_s))}`;
    case 'webhook':
      return `Signed POST${str(c.secret_ref) ? ` · secret ${str(c.secret_ref)}` : ''}`;
    case 'watch': {
      const adapter = str(c.adapter);
      const every = `every ${formatEvery(num(c.interval_s) || DEFAULT_WATCH_INTERVAL_S)}`;
      if (adapter === 'rss') return `RSS ${clip(str(c.url))} · ${every}`;
      if (adapter === 'directory') return `Directory ${clip(str(c.path))} · ${every}`;
      if (adapter === 'github') {
        const what = Array.isArray(c.what) ? c.what.join(', ') : 'issues, pulls';
        return `GitHub ${str(c.repo)} (${what}) · ${every}`;
      }
      if (adapter === 'http_json') return `JSON ${clip(str(c.url))} by ${str(c.id_field) || '?'} · ${every}`;
      return `Watch ${adapter || '?'} · ${every}`;
    }
    case 'run_completed': {
      const f = filterParts([['status', c.status], ['source', c.source], ['project', c.project_id]]);
      return `Any run completes${f ? ` · ${f}` : ''}${c.allow_bot_origin === true ? ' · includes bot runs' : ''}`;
    }
    case 'kanban_event': {
      const f = filterParts([['event', c.event], ['project', c.project_id]]);
      return `Board event${f ? ` · ${f}` : ''}${c.allow_bot_origin === true ? ' · includes bot-created tasks' : ''}`;
    }
    case 'interrupt_created': {
      const f = filterParts([['kind', c.kind], ['severity', c.severity]]);
      return `Interrupt raised${f ? ` · ${f}` : ''}${c.allow_bot_origin === true ? ' · includes bot interrupts' : ''}`;
    }
    case 'peer_message': return 'Messages from other bots';
    case 'ask_bot': return 'Questions from other bots';
    case 'commitment_due': return 'A commitment comes due';
    case 'operator_message': return 'You message the bot';
    case 'manual': return 'Run now / wake';
    default: return clip(JSON.stringify(c), 80);
  }
}

export type TriggerHealth = { error: string | null; errorAt: string | null; polledAt: string | null };

/** The watch adapter's last failure (and last successful poll) recorded in the trigger cursor. */
export function triggerHealth(trigger: Pick<BotTrigger, 'cursor'>): TriggerHealth {
  const cursor = trigger.cursor ?? {};
  const error = str(cursor.last_error);
  return { error: error || null, errorAt: str(cursor.last_error_at) || null, polledAt: str(cursor.last_polled_at) || null };
}

/** `/api/hooks/bots/<triggerId>` as an absolute URL when an origin is known. */
export function webhookPath(triggerId: string): string {
  return `/api/hooks/bots/${encodeURIComponent(triggerId)}`;
}

export function webhookUrl(triggerId: string, origin = ''): string {
  return `${origin.replace(/\/+$/, '')}${webhookPath(triggerId)}`;
}

export const SIGNATURE_HEADER_DOC =
  'Sign the raw request body with HMAC-SHA256 using the secret and send it in the X-Webhook-Signature header (hex, optionally prefixed "sha256="). Add an X-Webhook-Id (or X-GitHub-Delivery) header so retries are not processed twice.';

// ---- schedule preview ----------------------------------------------------------------------

export type SchedulePreview = { cron: string; description: string; timezone?: string; exclusions: string[] };

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Narrow the POST /triggers/compile-schedule body (typed loosely) to what the preview shows. */
export function readCompiledSchedule(body: Record<string, unknown>): SchedulePreview | null {
  const cron = str(body.cron);
  if (!cron) return null;
  const exclusions = (body.exclusions ?? {}) as { weekdays?: unknown; dates?: unknown };
  const lines: string[] = [];
  if (Array.isArray(exclusions.weekdays) && exclusions.weekdays.length) {
    lines.push(`Skips ${exclusions.weekdays.map((d) => DAYS[Number(d)] ?? String(d)).join(', ')}`);
  }
  if (Array.isArray(exclusions.dates) && exclusions.dates.length) lines.push(`Skips ${exclusions.dates.map(String).join(', ')}`);
  return { cron, description: str(body.description), ...(str(body.timezone) ? { timezone: str(body.timezone) } : {}), exclusions: lines };
}

// ---- events --------------------------------------------------------------------------------

export const TRUST_LABELS: Record<BotEvent['trust'], string> = {
  operator: 'You',
  internal: 'CloudCLI',
  external: 'External',
};

/** A compact label for an event row. */
export function describeEvent(event: Pick<BotEvent, 'kind' | 'source' | 'payload'>): string {
  const p = event.payload ?? {};
  const pick = str(p.title) || str(p.summary) || str(p.note) || str(p.description) || str(p.status);
  const head = event.kind === 'schedule' ? `Scheduled (${event.source.replace(/^trigger:/, '')})` : event.kind.replace(/_/g, ' ');
  return pick ? `${head} · ${clip(pick, 70)}` : head;
}
