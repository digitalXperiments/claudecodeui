/**
 * Studio Parallel Universes — client-facing payload types.
 *
 * A "universe" is one goal explored through exactly two named, independent
 * implementation approaches. Each approach runs as its own isolated Agent
 * Relay job (see server/modules/agent-relay) against the *actual* selected
 * project repository — not a synthetic HTML mock like the rest of Studio.
 *
 * Source of truth for the API. Keep `src/components/studio/universes/types.ts`
 * in sync with this file.
 */

import type { LLMProvider } from '@/shared/types.js';

export const STUDIO_UNIVERSE_FORMAT = 'cloudcli.studio.universe.v1';

/** Mirrors AgentRelayStatus, plus `unknown` for a variant that never launched. */
export type UniverseVariantStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'unknown';

export type UniverseStatus = 'running' | 'ready' | 'partial' | 'failed';

export type UniversePreviewStatus = 'stopped' | 'starting' | 'running' | 'failed' | 'exited';

export type UniversePreviewState = {
  status: UniversePreviewStatus;
  command: string | null;
  pid: number | null;
  port: number | null;
  url: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
  exitCode: number | null;
  error: string | null;
  /** Bounded ring buffer of the most recent combined stdout/stderr lines. */
  logTail: string[];
};

export const STOPPED_PREVIEW: UniversePreviewState = {
  status: 'stopped',
  command: null,
  pid: null,
  port: null,
  url: null,
  startedAt: null,
  stoppedAt: null,
  exitCode: null,
  error: null,
  logTail: [],
};

export type UniverseVariantResult = {
  summary: string;
  evidence: string[];
  filesTouched: string[];
  testsRun: string[];
  openQuestions: string[];
};

export type UniverseAppliedRecord = {
  at: string;
  committed: boolean;
  commitSha: string | null;
  applied: string[];
  skipped: Array<{ path: string; reason: string }>;
};

export type UniverseVariant = {
  id: string;
  label: string;
  approach: string;
  provider: LLMProvider;
  model: string;
  relayId: string | null;
  batchId: string | null;
  workspaceId: string | null;
  branch: string | null;
  status: UniverseVariantStatus;
  error: string | null;
  result: UniverseVariantResult | null;
  preview: UniversePreviewState;
  applied: UniverseAppliedRecord | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
};

export type StudioUniverse = {
  format: typeof STUDIO_UNIVERSE_FORMAT;
  id: string;
  projectId: string;
  goal: string;
  status: UniverseStatus;
  variants: UniverseVariant[];
  createdAt: string;
  updatedAt: string;
};

export type CreateUniverseApproachInput = {
  label: string;
  approach: string;
  provider: LLMProvider;
  model: string;
};

export type CreateStudioUniverseInput = {
  projectId: string;
  goal: string;
  approaches: [CreateUniverseApproachInput, CreateUniverseApproachInput];
  timeoutMs?: number;
};

export type StartUniversePreviewInput = {
  command: string;
  port?: number;
};

export type ApplyUniverseVariantInput = {
  commit?: boolean;
  message?: string;
};

export type UniverseDiffFile = { path: string; status: string; patch?: string };

export type UniverseDiffResult = {
  files: UniverseDiffFile[];
  summary: { additions: number; deletions: number };
};
