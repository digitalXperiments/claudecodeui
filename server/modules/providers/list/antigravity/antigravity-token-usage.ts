/**
 * Token usage extractor for Antigravity conversations.
 *
 * Reads per-turn token counts and model identities from Antigravity's on-disk
 * SQLite conversation stores (`<sessionId>.db`), specifically the `gen_metadata`
 * table whose protobuf blobs carry Gemini `UsageMetadata`.
 */

import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { getConnection } from '@/modules/database/index.js';
import {
  antigravityConversationsDir,
  decodeProtobufFields,
  firstBytes,
  firstVarint,
  STEP_TYPE_USER_INPUT,
  type WireField,
} from './antigravity-conversation-store.js';

export type AntigravitySessionTokenUsage = {
  used: number;
  total: number;
  contextUsed: number;
  contextWindow: number;
  contextFree: number;
  contextPercent: number | null;
  lastTurnInputTokens: number;
  lastTurnOutputTokens: number;
  inputTokens: number;
  outputTokens: number;
  billedInputTokens: number;
  billedOutputTokens: number;
  cumulativeUsed: number;
  model: string | null;
  provider: 'antigravity';
  breakdown: { input: number; output: number };
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

export type AntigravityGenerationRecord = {
  idx: number;
  lastStepIdx: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  model: string | null;
};

export type AntigravityRunSnapshot = {
  turnIndex: number;
  userStepIdx: number;
  cumulativeInput: number;
  cumulativeOutput: number;
  cumulativeCacheRead: number;
  model: string | null;
};

/**
 * Resolve the path to an Antigravity conversation database file.
 * Handles:
 * 1. An absolute path to a .db file.
 * 2. A providerSessionId: `<conversationsDir>/<providerSessionId>.db`.
 * 3. An app sessionId: looks up `provider_session_id` in `sessions` table.
 */
export function resolveAntigravityDbPath(
  sessionIdOrPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!sessionIdOrPath) return null;

  if (path.isAbsolute(sessionIdOrPath) && sessionIdOrPath.endsWith('.db')) {
    if (fs.existsSync(sessionIdOrPath)) return sessionIdOrPath;
  }

  const dir = antigravityConversationsDir(env);
  const directPath = path.join(dir, `${sessionIdOrPath}.db`);
  if (fs.existsSync(directPath)) return directPath;

  // Check if sessionIdOrPath is an app session ID mapped in `sessions` table
  try {
    const db = getConnection();
    const row = db
      .prepare('SELECT provider_session_id FROM sessions WHERE session_id = ? OR provider_session_id = ?')
      .get(sessionIdOrPath, sessionIdOrPath) as { provider_session_id?: string } | undefined;
    if (row?.provider_session_id) {
      const mappedPath = path.join(dir, `${row.provider_session_id}.db`);
      if (fs.existsSync(mappedPath)) return mappedPath;
    }
  } catch {
    // Database lookup non-fatal
  }

  return null;
}

/**
 * Extract generation records from a conversation database's `gen_metadata` table.
 */
export function extractAntigravityGenerations(db: Database.Database): AntigravityGenerationRecord[] {
  let rows: Array<{ idx: number; data: Buffer }> = [];
  try {
    rows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all() as Array<{
      idx: number;
      data: Buffer;
    }>;
  } catch {
    return [];
  }

  const records: AntigravityGenerationRecord[] = [];
  for (const row of rows) {
    if (!row.data || !Buffer.isBuffer(row.data)) continue;
    const top = decodeProtobufFields(row.data);
    if (!top) continue;
    const f1 = firstBytes(top, 1);
    if (!f1) continue;
    const sub = decodeProtobufFields(f1);
    if (!sub) continue;

    // Field 4: UsageMetadata
    const f4 = firstBytes(sub, 4);
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    if (f4) {
      const f4Fields = decodeProtobufFields(f4);
      if (f4Fields) {
        inputTokens = firstVarint(f4Fields, 2) ?? 0;
        outputTokens = firstVarint(f4Fields, 3) ?? 0;
        cacheReadTokens = firstVarint(f4Fields, 5) ?? 0;
      }
    }

    // Model name: field 27.8 or field 19
    let model: string | null = null;
    const f27 = firstBytes(sub, 27);
    if (f27) {
      const f27Fields = decodeProtobufFields(f27);
      const mStr = firstBytes(f27Fields, 8);
      if (mStr && mStr.length > 0) {
        model = mStr.toString('utf8');
      }
    }
    if (!model) {
      const f19 = firstBytes(sub, 19);
      if (f19 && f19.length > 0) {
        model = f19.toString('utf8');
      }
    }

    // Field 20: repeated key-value pairs
    let lastStepIdx = -1;
    const f20Items = sub.filter((entry): entry is { field: number; kind: 'bytes'; value: Buffer } =>
      entry.field === 20 && entry.kind === 'bytes',
    );
    for (const item of f20Items) {
      const itemFields = decodeProtobufFields(item.value);
      const keyBytes = firstBytes(itemFields, 1);
      const valBytes = firstBytes(itemFields, 2);
      if (keyBytes && valBytes && keyBytes.toString('utf8') === 'last_step_index') {
        const parsed = parseInt(valBytes.toString('utf8'), 10);
        if (Number.isFinite(parsed)) {
          lastStepIdx = parsed;
        }
      }
    }

    records.push({
      idx: row.idx,
      lastStepIdx,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      model,
    });
  }

  return records;
}

/**
 * Reads token usage for an entire Antigravity session up to its current state.
 */
export function readAntigravitySessionTokenUsage(
  sessionIdOrPath: string,
  env: NodeJS.ProcessEnv = process.env,
): AntigravitySessionTokenUsage | null {
  const dbPath = resolveAntigravityDbPath(sessionIdOrPath, env);
  if (!dbPath) return null;

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const gens = extractAntigravityGenerations(db);
    if (gens.length === 0) return null;

    let cumulativeInput = 0;
    let cumulativeOutput = 0;
    let cumulativeCacheRead = 0;
    let latestModel: string | null = null;

    for (const g of gens) {
      cumulativeInput += g.inputTokens;
      cumulativeOutput += g.outputTokens;
      cumulativeCacheRead += g.cacheReadTokens;
      if (g.model) latestModel = g.model;
    }

    const last = gens[gens.length - 1];
    const lastTurnInputTokens = last.inputTokens;
    const lastTurnOutputTokens = last.outputTokens;

    // Context window: Flash models 1M tokens, Pro models 2M tokens
    const isPro = latestModel?.toLowerCase().includes('pro') ?? false;
    const contextWindow = isPro ? 2_000_000 : 1_000_000;
    const contextUsed = lastTurnInputTokens + lastTurnOutputTokens;
    const contextFree = Math.max(0, contextWindow - contextUsed);
    const contextPercent = contextWindow > 0 ? (contextUsed / contextWindow) * 100 : null;

    return {
      used: lastTurnInputTokens + lastTurnOutputTokens,
      total: contextWindow,
      contextUsed,
      contextWindow,
      contextFree,
      contextPercent,
      lastTurnInputTokens,
      lastTurnOutputTokens,
      inputTokens: lastTurnInputTokens,
      outputTokens: lastTurnOutputTokens,
      billedInputTokens: cumulativeInput,
      billedOutputTokens: cumulativeOutput,
      cumulativeUsed: cumulativeInput + cumulativeOutput,
      model: latestModel,
      provider: 'antigravity',
      breakdown: {
        input: lastTurnInputTokens,
        output: lastTurnOutputTokens,
      },
      cacheReadTokens: cumulativeCacheRead,
      cacheCreationTokens: 0,
    };
  } catch (error) {
    console.warn('[Antigravity] failed to read session token usage:', error);
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // closed
    }
  }
}

/**
 * Splits generations into per-run cumulative snapshots based on user prompt steps (step_type = 14).
 * Used for historical reconciliation of completed runs.
 */
export function readAntigravityRunSnapshots(
  sessionIdOrPath: string,
  env: NodeJS.ProcessEnv = process.env,
): AntigravityRunSnapshot[] {
  const dbPath = resolveAntigravityDbPath(sessionIdOrPath, env);
  if (!dbPath) return [];

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    let userSteps: number[] = [];
    try {
      userSteps = (
        db.prepare('SELECT idx FROM steps WHERE step_type = ? ORDER BY idx ASC').all(STEP_TYPE_USER_INPUT) as Array<{
          idx: number;
        }>
      ).map((s) => s.idx);
    } catch {
      userSteps = [];
    }

    const gens = extractAntigravityGenerations(db);
    if (gens.length === 0) return [];

    if (userSteps.length === 0) {
      // Single turn fallback
      const cumIn = gens.reduce((acc, g) => acc + g.inputTokens, 0);
      const cumOut = gens.reduce((acc, g) => acc + g.outputTokens, 0);
      const cumCache = gens.reduce((acc, g) => acc + g.cacheReadTokens, 0);
      const lastModel = gens.map((g) => g.model).filter(Boolean).pop() ?? null;
      return [
        {
          turnIndex: 0,
          userStepIdx: 0,
          cumulativeInput: cumIn,
          cumulativeOutput: cumOut,
          cumulativeCacheRead: cumCache,
          model: lastModel,
        },
      ];
    }

    const snapshots: AntigravityRunSnapshot[] = [];
    for (let i = 0; i < userSteps.length; i++) {
      const currentStep = userSteps[i];
      const nextStep = i + 1 < userSteps.length ? userSteps[i + 1] : Infinity;
      const activeGens = gens.filter((g) => g.lastStepIdx < nextStep);
      const cumIn = activeGens.reduce((acc, g) => acc + g.inputTokens, 0);
      const cumOut = activeGens.reduce((acc, g) => acc + g.outputTokens, 0);
      const cumCache = activeGens.reduce((acc, g) => acc + g.cacheReadTokens, 0);
      const activeModel = activeGens.map((g) => g.model).filter(Boolean).pop() ?? null;

      snapshots.push({
        turnIndex: i,
        userStepIdx: currentStep,
        cumulativeInput: cumIn,
        cumulativeOutput: cumOut,
        cumulativeCacheRead: cumCache,
        model: activeModel,
      });
    }

    return snapshots;
  } catch (error) {
    console.warn('[Antigravity] failed to read run snapshots:', error);
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      // closed
    }
  }
}
