/** Kernel output envelope: parsing the agent's final message into a validated structure. */

import { parseJsonFromAgentText } from '@/modules/mission-control/index.js';

export interface KernelEnvelope {
  summary: string;
  plan: string;
  /** Raw drafts, handed to `ingestProduceDrafts` (which does its own validation). */
  items: unknown[];
  commitments: Array<Record<string, unknown>>;
  goalProgress: Array<Record<string, unknown>>;
  notify: { title: string; body: string; urgency: number } | null;
  /** A conversational answer to the operator: posted to the bot thread and the originating channel. */
  reply: string;
}

const ENVELOPE_KEYS = ['summary', 'plan', 'items', 'commitments', 'goal_progress', 'notify', 'reply'] as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const objectArray = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value) ? value.filter(isObject) : [];

function toText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function parseNotify(value: unknown): KernelEnvelope['notify'] {
  if (!isObject(value)) return null;
  const title = toText(value.title, 200);
  const body = toText(value.body, 2000);
  if (!title || !body) return null;
  const urgency = typeof value.urgency === 'number' && Number.isFinite(value.urgency) ? value.urgency : 0.5;
  return { title, body, urgency: Math.min(1, Math.max(0, urgency)) };
}

/**
 * Accepts the full envelope, a bare array of items (legacy produce prompts) or a single draft
 * object. Throws when the text contains no JSON at all.
 */
export function parseKernelEnvelope(text: string): KernelEnvelope {
  const parsed = parseJsonFromAgentText(text);
  const empty: KernelEnvelope = { summary: '', plan: '', items: [], commitments: [], goalProgress: [], notify: null, reply: '' };
  if (Array.isArray(parsed)) return { ...empty, items: parsed };
  if (!isObject(parsed)) return empty;
  if (!ENVELOPE_KEYS.some((key) => key in parsed)) {
    // A single draft object or a legacy { drafts | results } wrapper: let the pipeline sort it out.
    return { ...empty, items: [parsed] };
  }
  return {
    summary: toText(parsed.summary, 2000),
    plan: toText(parsed.plan, 8000),
    items: Array.isArray(parsed.items) ? parsed.items : parsed.items && isObject(parsed.items) ? [parsed.items] : [],
    commitments: objectArray(parsed.commitments),
    goalProgress: objectArray(parsed.goal_progress),
    notify: parseNotify(parsed.notify),
    reply: toText(parsed.reply, 4000),
  };
}

export interface TriageVerdict {
  relevantEventIds: string[];
  reason: string;
}

/** Returns null when the triage output cannot be understood (callers then keep every event). */
export function parseTriageVerdict(text: string): TriageVerdict | null {
  let parsed: unknown;
  try {
    parsed = parseJsonFromAgentText(text);
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  const ids = parsed.relevant_event_ids;
  if (!Array.isArray(ids)) return null;
  return {
    relevantEventIds: ids.filter((id): id is string => typeof id === 'string'),
    reason: toText(parsed.reason, 500),
  };
}
