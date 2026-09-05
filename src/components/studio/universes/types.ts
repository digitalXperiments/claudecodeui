/**
 * Client-facing Parallel Universes payload types.
 * Kept in sync with server/modules/studio/studio-universes.types.ts.
 */

import type { LLMProvider } from '../../../types/app';

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
  logTail: string[];
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
  id: string;
  projectId: string;
  goal: string;
  status: UniverseStatus;
  variants: UniverseVariant[];
  createdAt: string;
  updatedAt: string;
};

export type UniverseDiffFile = { path: string; status: string; patch?: string };

export type UniverseDiffResult = {
  files: UniverseDiffFile[];
  summary: { additions: number; deletions: number };
};

export type CreateUniverseApproachDraft = {
  label: string;
  approach: string;
  provider: LLMProvider | '';
  model: string;
};
