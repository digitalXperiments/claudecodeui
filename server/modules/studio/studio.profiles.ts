import { appConfigDb } from '@/modules/database/index.js';
import type { SwarmAgentSpec } from '@/modules/swarm/swarm.types.js';

export const STUDIO_ROSTER_CONFIG_KEY = 'studio_design_roster';

export type StudioSeatId = 'architect' | 'builder' | 'reviewer';

export type StudioSeatProfile = {
  id: StudioSeatId;
  enabled: boolean;
  label: string;
  kind: 'orchestrator' | 'implementer' | 'reviewer';
  provider: string;
  model: string | null;
  effort: string;
  permissionMode: string;
  focus: string;
};

export const DEFAULT_STUDIO_SEATS: StudioSeatProfile[] = [
  {
    id: 'architect',
    enabled: true,
    label: 'Product architect',
    kind: 'orchestrator',
    provider: 'claude',
    model: null,
    effort: 'medium',
    permissionMode: 'bypassPermissions',
    focus:
      'Plan a short two-step design job: builder rewrites prototype.html, reviewer walks every click. Do not send explorers into the host repo.',
  },
  {
    id: 'builder',
    enabled: true,
    label: 'Prototype builder',
    kind: 'implementer',
    provider: 'claude',
    model: null,
    effort: 'high',
    permissionMode: 'bypassPermissions',
    focus:
      'Replace prototype.html with a self-contained, brand-specific clickable page. Update notes.md and handoff.md. Touch only the prototype directory.',
  },
  {
    id: 'reviewer',
    enabled: true,
    label: 'Click-through reviewer',
    kind: 'reviewer',
    provider: 'claude',
    model: null,
    effort: 'medium',
    permissionMode: 'bypassPermissions',
    focus:
      'Walk every primary path in prototype.html. File gaps in notes.md. Dead buttons fail the review.',
  },
];

const ALLOWED_KINDS = new Set(['orchestrator', 'implementer', 'reviewer']);
const ALLOWED_IDS = new Set<StudioSeatId>(['architect', 'builder', 'reviewer']);

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeSeat(raw: unknown, fallback: StudioSeatProfile): StudioSeatProfile {
  const row = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const id = ALLOWED_IDS.has(row.id as StudioSeatId) ? (row.id as StudioSeatId) : fallback.id;
  const kind = ALLOWED_KINDS.has(String(row.kind))
    ? (row.kind as StudioSeatProfile['kind'])
    : fallback.kind;
  return {
    id,
    enabled: row.enabled === undefined ? fallback.enabled : Boolean(row.enabled),
    label: asString(row.label, fallback.label),
    kind,
    provider: asString(row.provider, fallback.provider),
    model: typeof row.model === 'string' && row.model.trim() ? row.model.trim() : null,
    effort: asString(row.effort, fallback.effort),
    permissionMode: asString(row.permissionMode, fallback.permissionMode),
    focus: asString(row.focus, fallback.focus),
  };
}

export function normalizeStudioSeats(input: unknown): StudioSeatProfile[] {
  const byId = new Map<StudioSeatId, unknown>();
  if (Array.isArray(input)) {
    for (const item of input) {
      if (item && typeof item === 'object' && ALLOWED_IDS.has((item as { id?: StudioSeatId }).id as StudioSeatId)) {
        byId.set((item as { id: StudioSeatId }).id, item);
      }
    }
  }
  return DEFAULT_STUDIO_SEATS.map((seat) => normalizeSeat(byId.get(seat.id), seat));
}

export function getStudioSeats(): StudioSeatProfile[] {
  const raw = appConfigDb.get(STUDIO_ROSTER_CONFIG_KEY);
  if (!raw) return DEFAULT_STUDIO_SEATS.map((seat) => ({ ...seat }));
  try {
    return normalizeStudioSeats(JSON.parse(raw));
  } catch {
    return DEFAULT_STUDIO_SEATS.map((seat) => ({ ...seat }));
  }
}

export function saveStudioSeats(input: unknown): StudioSeatProfile[] {
  const seats = normalizeStudioSeats(input);
  const architect = seats.find((seat) => seat.id === 'architect');
  if (architect) architect.enabled = true;
  const builder = seats.find((seat) => seat.id === 'builder');
  if (builder) builder.enabled = true;
  appConfigDb.set(STUDIO_ROSTER_CONFIG_KEY, JSON.stringify(seats));
  return seats;
}

export function seatsToRoster(seats = getStudioSeats()): SwarmAgentSpec[] {
  return seats
    .filter((seat) => seat.enabled)
    .map((seat) => ({
      id: seat.id,
      kind: seat.kind,
      label: seat.label,
      provider: seat.provider,
      model: seat.model,
      effort: seat.effort,
      permissionMode: seat.permissionMode,
      skills: ['clickable-prototype'],
      focus: seat.focus,
    }));
}
