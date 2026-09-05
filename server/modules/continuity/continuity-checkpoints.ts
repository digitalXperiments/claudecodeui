import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/index.js';
import type { LLMProvider } from '@/shared/types.js';

export type ContinuityCheckpoint = {
  checkpointId: string;
  sessionId: string;
  lineageRootSessionId: string;
  provider: LLMProvider;
  runId: string | null;
  summary: string;
  nextSteps: string[];
  openQuestions: string[];
  filesTouched: string[];
  commands: string[];
  doNotRepeat: string[];
  tags: string[];
  createdAt: string;
};

export type CreateCheckpointInput = Omit<
  ContinuityCheckpoint,
  'checkpointId' | 'createdAt'
>;

export type ContinuityScratchpadEntry = {
  lineageRootSessionId: string;
  key: string;
  value: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SetScratchpadInput = {
  lineageRootSessionId: string;
  key: string;
  value: string;
  ttlSeconds?: number | null;
};

type CheckpointRow = {
  checkpoint_id: string;
  session_id: string;
  lineage_root_session_id: string;
  provider: string;
  run_id: string | null;
  summary: string;
  next_steps_json: string;
  open_questions_json: string;
  files_touched_json: string;
  commands_json: string;
  do_not_repeat_json: string;
  tags_json: string;
  created_at: string;
};

type ScratchpadRow = {
  lineage_root_session_id: string;
  key: string;
  value: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};

function ensureTables(): void {
  getConnection().exec(`
    CREATE TABLE IF NOT EXISTS continuity_checkpoints (
      checkpoint_id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL,
      lineage_root_session_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      run_id TEXT,
      seq INTEGER NOT NULL DEFAULT 1,
      summary TEXT NOT NULL,
      next_steps_json TEXT NOT NULL DEFAULT '[]',
      open_questions_json TEXT NOT NULL DEFAULT '[]',
      files_touched_json TEXT NOT NULL DEFAULT '[]',
      commands_json TEXT NOT NULL DEFAULT '[]',
      do_not_repeat_json TEXT NOT NULL DEFAULT '[]',
      tags_json TEXT NOT NULL DEFAULT '[]',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_continuity_checkpoints_session
      ON continuity_checkpoints(session_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS continuity_scratchpad (
      lineage_root_session_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      expires_at DATETIME,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (lineage_root_session_id, key)
    );
    CREATE INDEX IF NOT EXISTS idx_continuity_scratchpad_expiry
      ON continuity_scratchpad(expires_at);
  `);
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    return [];
  }
}

function mapCheckpoint(row: CheckpointRow): ContinuityCheckpoint {
  return {
    checkpointId: row.checkpoint_id,
    sessionId: row.session_id,
    lineageRootSessionId: row.lineage_root_session_id,
    provider: row.provider as LLMProvider,
    runId: row.run_id,
    summary: row.summary,
    nextSteps: parseStringArray(row.next_steps_json),
    openQuestions: parseStringArray(row.open_questions_json),
    filesTouched: parseStringArray(row.files_touched_json),
    commands: parseStringArray(row.commands_json),
    doNotRepeat: parseStringArray(row.do_not_repeat_json),
    tags: parseStringArray(row.tags_json),
    createdAt: row.created_at,
  };
}

function mapScratchpad(row: ScratchpadRow): ContinuityScratchpadEntry {
  return {
    lineageRootSessionId: row.lineage_root_session_id,
    key: row.key,
    value: row.value,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function removeExpiredScratchpadEntries(): void {
  getConnection().prepare(
    "DELETE FROM continuity_scratchpad WHERE expires_at IS NOT NULL AND datetime(expires_at) <= CURRENT_TIMESTAMP",
  ).run();
}

export const continuityCheckpointsRepository = {
  createCheckpoint(input: CreateCheckpointInput): ContinuityCheckpoint {
    ensureTables();
    const checkpointId = `checkpoint_${randomUUID()}`;
    getConnection().prepare(
      `INSERT INTO continuity_checkpoints (
         checkpoint_id, session_id, lineage_root_session_id, provider, run_id,
         seq, summary, next_steps_json, open_questions_json, files_touched_json,
         commands_json, do_not_repeat_json, tags_json
       ) VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM continuity_checkpoints WHERE session_id = ?), ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      checkpointId,
      input.sessionId,
      input.lineageRootSessionId,
      input.provider,
      input.runId,
      input.sessionId,
      input.summary,
      JSON.stringify(input.nextSteps),
      JSON.stringify(input.openQuestions),
      JSON.stringify(input.filesTouched),
      JSON.stringify(input.commands),
      JSON.stringify(input.doNotRepeat),
      JSON.stringify(input.tags),
    );
    return this.getLatestCheckpoint(input.sessionId)!;
  },

  getLatestCheckpoint(sessionId: string): ContinuityCheckpoint | null {
    ensureTables();
    const row = getConnection().prepare(
      `SELECT * FROM continuity_checkpoints
       WHERE session_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`,
    ).get(sessionId) as CheckpointRow | undefined;
    return row ? mapCheckpoint(row) : null;
  },

  setScratchpad(input: SetScratchpadInput): ContinuityScratchpadEntry | null {
    ensureTables();
    const ttlSeconds = input.ttlSeconds == null
      ? null
      : Math.max(0, Math.floor(input.ttlSeconds));
    const expiresAt = ttlSeconds == null
      ? null
      : new Date(Date.now() + ttlSeconds * 1_000).toISOString();
    getConnection().prepare(
      `INSERT INTO continuity_scratchpad (
         lineage_root_session_id, key, value, expires_at
       ) VALUES (?, ?, ?, ?)
       ON CONFLICT(lineage_root_session_id, key) DO UPDATE SET
         value = excluded.value,
         expires_at = excluded.expires_at,
         updated_at = CURRENT_TIMESTAMP`,
    ).run(input.lineageRootSessionId, input.key, input.value, expiresAt);
    return this.getScratchpad({
      lineageRootSessionId: input.lineageRootSessionId,
      key: input.key,
    })!;
  },

  getScratchpad(input: Pick<SetScratchpadInput, 'lineageRootSessionId' | 'key'>): ContinuityScratchpadEntry | null {
    ensureTables();
    removeExpiredScratchpadEntries();
    const row = getConnection().prepare(
      `SELECT * FROM continuity_scratchpad
       WHERE lineage_root_session_id = ? AND key = ?`,
    ).get(input.lineageRootSessionId, input.key) as ScratchpadRow | undefined;
    return row ? mapScratchpad(row) : null;
  },

  listScratchpad(lineageRootSessionId: string): ContinuityScratchpadEntry[] {
    ensureTables();
    removeExpiredScratchpadEntries();
    const rows = getConnection().prepare(
      `SELECT * FROM continuity_scratchpad
       WHERE lineage_root_session_id = ?
       ORDER BY key ASC`,
    ).all(lineageRootSessionId) as ScratchpadRow[];
    return rows.map(mapScratchpad);
  },
};

export async function resolveLineageRoot(sessionId: string): Promise<string> {
  const visited = new Set<string>();
  let currentSessionId = sessionId;

  while (!visited.has(currentSessionId)) {
    visited.add(currentSessionId);
    const row = getConnection().prepare(
      'SELECT continued_from_session_id FROM sessions WHERE session_id = ?',
    ).get(currentSessionId) as { continued_from_session_id: string | null } | undefined;
    if (!row?.continued_from_session_id) return currentSessionId;
    currentSessionId = row.continued_from_session_id;
  }

  return currentSessionId;
}

function markdownList(values: string[]): string {
  return values.length > 0 ? values.map((value) => `- ${value}`).join('\n') : '- None';
}

export function formatCheckpointForPrompt(checkpoint: ContinuityCheckpoint): string {
  return [
    '### Agent Checkpoint',
    '',
    checkpoint.summary.trim(),
    '',
    '**Next steps**',
    markdownList(checkpoint.nextSteps),
    '',
    '**Open questions**',
    markdownList(checkpoint.openQuestions),
    '',
    '**Files touched**',
    markdownList(checkpoint.filesTouched),
  ].join('\n');
}

export const createCheckpoint = continuityCheckpointsRepository.createCheckpoint.bind(continuityCheckpointsRepository);
export const getLatestCheckpoint = continuityCheckpointsRepository.getLatestCheckpoint.bind(continuityCheckpointsRepository);
export const setScratchpad = continuityCheckpointsRepository.setScratchpad.bind(continuityCheckpointsRepository);
export const getScratchpad = continuityCheckpointsRepository.getScratchpad.bind(continuityCheckpointsRepository);
export const listScratchpad = continuityCheckpointsRepository.listScratchpad.bind(continuityCheckpointsRepository);

// Singular alias retained for callers that treat this as one checkpoint store.
export const continuityCheckpointRepository = continuityCheckpointsRepository;

export const resolveLineageRootSessionId = resolveLineageRoot;
