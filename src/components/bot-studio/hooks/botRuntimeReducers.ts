/**
 * Pure state logic for the Bot Runtime v2 data hooks: list upserts, the per-bot section store and
 * the websocket-frame router. Kept free of React so it can be unit-tested with `node --test`.
 */

import type {
  BotBudgetStatus,
  BotCommitment,
  BotEpisode,
  BotEvent,
  BotGateDecisionView,
  BotGoal,
  BotProposal,
  BotSkill,
  BotThreadMessage,
  BotTrigger,
} from '../types/botRuntime';

// ---- list helpers -------------------------------------------------------------------------------

/** Replace the entry with the same id (keeping its position) or add it at the front/back. */
export function upsertById<T>(list: T[], next: T, idOf: (item: T) => string, position: 'front' | 'back' = 'front'): T[] {
  const id = idOf(next);
  const index = list.findIndex((item) => idOf(item) === id);
  if (index >= 0) return list.map((item, i) => (i === index ? next : item));
  return position === 'front' ? [next, ...list] : [...list, next];
}

export const removeById = <T>(list: T[], id: string, idOf: (item: T) => string): T[] =>
  list.filter((item) => idOf(item) !== id);

/** Goals keep the server's `sort_order` ordering. */
export function upsertGoal(goals: BotGoal[], goal: BotGoal): BotGoal[] {
  const next = upsertById(goals, goal, (g) => g.goal_id, 'back');
  return [...next].sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at));
}

export const removeGoal = (goals: BotGoal[], goalId: string): BotGoal[] => removeById(goals, goalId, (g) => g.goal_id);

/** Commitments are ordered by `due_at` ascending, like the server. */
export function upsertCommitment(commitments: BotCommitment[], commitment: BotCommitment): BotCommitment[] {
  const next = upsertById(commitments, commitment, (c) => c.commitment_id, 'back');
  return [...next].sort((a, b) => a.due_at.localeCompare(b.due_at));
}

const newestFirst = <T>(timeOf: (item: T) => string) => (a: T, b: T) => timeOf(b).localeCompare(timeOf(a));

export function upsertEpisode(episodes: BotEpisode[], episode: BotEpisode, cap = 200): BotEpisode[] {
  return [...upsertById(episodes, episode, (e) => e.episode_id)].sort(newestFirst((e) => e.started_at)).slice(0, cap);
}

export function upsertEvent(events: BotEvent[], event: BotEvent, cap = 200): BotEvent[] {
  return [...upsertById(events, event, (e) => e.event_id)].sort(newestFirst((e) => e.received_at)).slice(0, cap);
}

export function upsertProposal(proposals: BotProposal[], proposal: BotProposal): BotProposal[] {
  return [...upsertById(proposals, proposal, (p) => p.proposal_id)].sort(newestFirst((p) => p.created_at));
}

export function upsertTrigger(triggers: BotTrigger[], trigger: BotTrigger): BotTrigger[] {
  return upsertById(triggers, trigger, (t) => t.trigger_id, 'back');
}

export function upsertSkill(skills: BotSkill[], skill: BotSkill): BotSkill[] {
  return upsertById(skills, skill, (s) => s.link_id, 'back');
}

export function upsertGateDecision(decisions: BotGateDecisionView[], decision: BotGateDecisionView, cap = 200): BotGateDecisionView[] {
  return [...upsertById(decisions, decision, (d) => d.decision_id)].sort(newestFirst((d) => d.created_at)).slice(0, cap);
}

// ---- thread -------------------------------------------------------------------------------------

export const THREAD_CAP = 500;

const THREAD_ROLES = ['operator', 'bot', 'system'];

/** Validate a websocket `bot_thread_message.message` payload; null when it is not a usable message. */
export function parseThreadMessage(value: unknown): BotThreadMessage | null {
  if (!value || typeof value !== 'object') return null;
  const m = value as Record<string, unknown>;
  if (typeof m.message_id !== 'string' || !m.message_id) return null;
  if (typeof m.bot_id !== 'string' || typeof m.body !== 'string' || typeof m.created_at !== 'string') return null;
  if (typeof m.role !== 'string' || !THREAD_ROLES.includes(m.role)) return null;
  return {
    message_id: m.message_id,
    bot_id: m.bot_id,
    role: m.role as BotThreadMessage['role'],
    body: m.body,
    channel: typeof m.channel === 'string' ? m.channel : 'inapp',
    meta: m.meta && typeof m.meta === 'object' && !Array.isArray(m.meta) ? (m.meta as Record<string, unknown>) : {},
    created_at: m.created_at,
  };
}

/**
 * Add a message to a chronological (oldest first) thread. Duplicates (by id) are replaced in place,
 * a message older than the tail is inserted in order, and the list is capped to the newest entries.
 */
export function appendThreadMessage(messages: BotThreadMessage[], message: BotThreadMessage, cap = THREAD_CAP): BotThreadMessage[] {
  const existing = messages.findIndex((m) => m.message_id === message.message_id);
  if (existing >= 0) return messages.map((m, i) => (i === existing ? message : m));
  const last = messages[messages.length - 1];
  let next: BotThreadMessage[];
  if (!last || last.created_at <= message.created_at) {
    next = [...messages, message];
  } else {
    next = [...messages, message].sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** Older page first: prepend a page fetched with `before`, dropping anything already present. */
export function prependThreadPage(messages: BotThreadMessage[], page: BotThreadMessage[]): BotThreadMessage[] {
  const known = new Set(messages.map((m) => m.message_id));
  return [...page.filter((m) => !known.has(m.message_id)), ...messages];
}

// ---- per-bot section store ----------------------------------------------------------------------

export type RuntimeSection =
  | 'goals'
  | 'commitments'
  | 'episodes'
  | 'events'
  | 'thread'
  | 'proposals'
  | 'skills'
  | 'triggers'
  | 'gateDecisions'
  | 'budget';

export const RUNTIME_SECTIONS: RuntimeSection[] = [
  'goals', 'commitments', 'episodes', 'events', 'thread', 'proposals', 'skills', 'triggers', 'gateDecisions', 'budget',
];

export type RuntimeSectionData = {
  goals: BotGoal[];
  commitments: BotCommitment[];
  episodes: BotEpisode[];
  events: BotEvent[];
  thread: BotThreadMessage[];
  proposals: BotProposal[];
  skills: BotSkill[];
  triggers: BotTrigger[];
  gateDecisions: BotGateDecisionView[];
  budget: BotBudgetStatus | null;
};

export type SectionLoadState = 'idle' | 'loading' | 'ready' | 'error';
export type SectionLoad = { state: SectionLoadState; error: string | null };

export type BotRuntimeState = {
  botId: string | null;
  data: RuntimeSectionData;
  load: Record<RuntimeSection, SectionLoad>;
};

export type BotRuntimeAction =
  | { type: 'reset'; botId: string | null }
  | { type: 'start'; botId: string; section: RuntimeSection }
  | { type: 'loaded'; botId: string; section: RuntimeSection; data: RuntimeSectionData[RuntimeSection] }
  | { type: 'failed'; botId: string; section: RuntimeSection; error: string }
  | { type: 'thread_message'; botId: string; message: BotThreadMessage }
  | { type: 'patch'; botId: string; section: RuntimeSection; update: (current: RuntimeSectionData[RuntimeSection]) => RuntimeSectionData[RuntimeSection] };

function emptyData(): RuntimeSectionData {
  return {
    goals: [], commitments: [], episodes: [], events: [], thread: [], proposals: [], skills: [], triggers: [],
    gateDecisions: [], budget: null,
  };
}

function idleLoad(): Record<RuntimeSection, SectionLoad> {
  return Object.fromEntries(RUNTIME_SECTIONS.map((section) => [section, { state: 'idle', error: null }])) as Record<RuntimeSection, SectionLoad>;
}

export function createRuntimeState(botId: string | null = null): BotRuntimeState {
  return { botId, data: emptyData(), load: idleLoad() };
}

/**
 * Every action carries the bot id it was issued for; one that no longer matches the current bot
 * (a slow response after the operator switched bots) is ignored.
 */
export function runtimeReducer(state: BotRuntimeState, action: BotRuntimeAction): BotRuntimeState {
  if (action.type === 'reset') return action.botId === state.botId && action.botId !== null ? state : createRuntimeState(action.botId);
  if (action.botId !== state.botId) return state;

  switch (action.type) {
    case 'start': {
      const current = state.load[action.section];
      // Keep showing stale data as 'ready' while it refreshes; only a first load reads as 'loading'.
      const next: SectionLoad = current.state === 'ready' ? current : { state: 'loading', error: null };
      return { ...state, load: { ...state.load, [action.section]: next } };
    }
    case 'loaded':
      return {
        ...state,
        data: { ...state.data, [action.section]: action.data },
        load: { ...state.load, [action.section]: { state: 'ready', error: null } },
      };
    case 'failed': {
      const current = state.load[action.section];
      // A failed refresh keeps the last good data visible; the error is still recorded.
      return {
        ...state,
        load: { ...state.load, [action.section]: { state: current.state === 'ready' ? 'ready' : 'error', error: action.error } },
      };
    }
    case 'thread_message':
      return { ...state, data: { ...state.data, thread: appendThreadMessage(state.data.thread, action.message) } };
    case 'patch':
      return { ...state, data: { ...state.data, [action.section]: action.update(state.data[action.section]) } };
    default:
      return state;
  }
}

// ---- websocket routing --------------------------------------------------------------------------

export type RuntimeEventEffect =
  | { type: 'refresh'; sections: RuntimeSection[] }
  | { type: 'thread_message'; message: BotThreadMessage };

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** The runtime event kinds a status/overview consumer cares about (any bot). */
export const RUNTIME_EVENT_KINDS = [
  'bot_event_received',
  'bot_episode_updated',
  'bot_gate_decision',
  'bot_thread_message',
  'bot_proposal_updated',
  'bot_goal_updated',
] as const;

export function runtimeEventKind(frame: unknown): string | null {
  const record = asRecord(frame);
  if (!record) return null;
  const kind = record.kind ?? record.type;
  return typeof kind === 'string' ? kind : null;
}

export const isRuntimeEventKind = (kind: string | null): boolean =>
  kind !== null && (RUNTIME_EVENT_KINDS as readonly string[]).includes(kind);

/**
 * Map a websocket frame to what a per-bot view should do: null when the frame is not a runtime event
 * or belongs to another bot. Refresh lists are targeted (only the sections the event can change);
 * the hook skips sections that were never loaded.
 */
export function routeRuntimeEvent(frame: unknown, botId: string | null): RuntimeEventEffect | null {
  const record = asRecord(frame);
  const kind = runtimeEventKind(frame);
  if (!record || !botId || !isRuntimeEventKind(kind) || record.bot_id !== botId) return null;

  switch (kind) {
    case 'bot_event_received':
      return { type: 'refresh', sections: ['events', 'triggers'] };
    case 'bot_episode_updated':
      // A running episode only changes the episode list; a finished one also moves commitments, cost and the budget.
      return {
        type: 'refresh',
        sections: record.status === 'running' ? ['episodes'] : ['episodes', 'commitments', 'budget', 'events'],
      };
    case 'bot_gate_decision':
      return { type: 'refresh', sections: ['gateDecisions', 'budget'] };
    case 'bot_thread_message': {
      const message = parseThreadMessage(record.message);
      return message && message.bot_id === botId ? { type: 'thread_message', message } : { type: 'refresh', sections: ['thread'] };
    }
    case 'bot_proposal_updated':
      return { type: 'refresh', sections: ['proposals', 'skills'] };
    case 'bot_goal_updated':
      return { type: 'refresh', sections: ['goals'] };
    default:
      return null;
  }
}

/** Merge refresh requests that arrive in a burst, preserving first-seen order. */
export function mergeSections(pending: RuntimeSection[], incoming: RuntimeSection[]): RuntimeSection[] {
  const merged = [...pending];
  for (const section of incoming) if (!merged.includes(section)) merged.push(section);
  return merged;
}
