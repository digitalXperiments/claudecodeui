/**
 * Local reader for Antigravity's on-disk conversation store.
 *
 * Antigravity writes one SQLite file per conversation under
 * `<GEMINI_HOME>/antigravity-acp/conversations/`:
 *
 *   <sessionId>.db    — a `steps` table whose `step_payload` blobs are protobuf
 *   <sessionId>.meta  — small JSON: `{ "cwd": "...", "mode_id": "..." }`
 *
 * What CloudCLI needs from here is a **session title**. ACP `session/list`
 * returns `"Session <id-prefix>"` for every row — literally the id, never a
 * name — so a sidebar fed from it shows "New Session" forever. The first user
 * prompt is the title every other provider uses, and it is the first step in
 * the store.
 *
 * Usage is NOT read from here. These blobs do carry per-step token counts, but
 * the `agy` CLI publishes the real quota buckets (see
 * `antigravity-cli-usage.ts`), and a locally-summed token count is a worse
 * answer than the vendor's own remaining-fraction.
 *
 * ## On parsing protobuf without a schema
 *
 * Google ships no `.proto` for this store, so this reads the **wire format**
 * directly and pulls out two field paths verified against a live 1.1.1 store:
 *
 *   step_payload.1     = step type (matches the `steps.step_type` column)
 *   step_payload.19.2  = user prompt text (step type 14)
 *
 * Wire-format parsing is forward-compatible in the way that matters here:
 * unknown fields are skipped rather than fatal, so a release that adds fields
 * still reads. A release that RENUMBERS them would yield no title — which is
 * why every reader below degrades to "nothing found" instead of throwing, and
 * why the step type is cross-checked against the `step_type` column that
 * SQLite stores in the clear.
 */

import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { antigravityProfileDirectory } from './antigravity-auth-support.js';

/** `steps.step_type` for a user turn. Verified against 1.1.1. */
const STEP_TYPE_USER_INPUT = 14;
/** `step_payload` field holding the user-input message for a type-14 step. */
const FIELD_USER_INPUT = 19;
/** `...19.2` — the prompt text itself. */
const FIELD_USER_INPUT_TEXT = 2;
/** Longest prompt prefix worth scanning for a title; titles are ~120 chars. */
const MAX_TITLE_SOURCE_CHARS = 600;

export type AntigravityConversationSummary = {
  sessionId: string;
  /** From the `.meta` sidecar; `null` when it is missing or unreadable. */
  cwd: string | null;
  /** First user prompt, whitespace-collapsed and trimmed; `null` when absent. */
  firstPrompt: string | null;
  /** Wall-clock of the last write to the conversation database. */
  updatedAt: Date;
  createdAt: Date;
  stepCount: number;
};

export function antigravityConversationsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(antigravityProfileDirectory(env), 'antigravity-acp', 'conversations');
}

// ---------------------------------------------------------------------------
// Minimal protobuf wire reader
// ---------------------------------------------------------------------------

type WireField =
  | { field: number; kind: 'varint'; value: number }
  | { field: number; kind: 'bytes'; value: Buffer }
  | { field: number; kind: 'fixed' };

function readVarint(buf: Buffer, start: number): { value: number; next: number } | null {
  let result = 0;
  let shift = 0;
  let i = start;
  while (i < buf.length) {
    const byte = buf[i];
    i += 1;
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value: result, next: i };
    shift += 7;
    // 10 bytes is the maximum legal varint; anything longer is corruption.
    if (shift > 63) return null;
  }
  return null;
}

/**
 * Decode one protobuf message into its top-level fields.
 *
 * Returns `null` on any malformed byte rather than a partial read: a partial
 * read of a mis-framed buffer produces plausible-looking garbage, and here that
 * would surface as a nonsense session title.
 */
export function decodeProtobufFields(buf: Buffer): WireField[] | null {
  const fields: WireField[] = [];
  let i = 0;
  while (i < buf.length) {
    const tag = readVarint(buf, i);
    if (!tag) return null;
    i = tag.next;
    const field = tag.value >>> 3;
    const wire = tag.value & 7;
    if (field === 0) return null;
    if (wire === 0) {
      const v = readVarint(buf, i);
      if (!v) return null;
      i = v.next;
      fields.push({ field, kind: 'varint', value: v.value });
    } else if (wire === 2) {
      const len = readVarint(buf, i);
      if (!len) return null;
      i = len.next;
      const end = i + len.value;
      if (end > buf.length) return null;
      fields.push({ field, kind: 'bytes', value: buf.subarray(i, end) });
      i = end;
    } else if (wire === 5) {
      if (i + 4 > buf.length) return null;
      i += 4;
      fields.push({ field, kind: 'fixed' });
    } else if (wire === 1) {
      if (i + 8 > buf.length) return null;
      i += 8;
      fields.push({ field, kind: 'fixed' });
    } else {
      // Groups (3/4) were removed from proto3 and never appear here.
      return null;
    }
  }
  return fields;
}

const firstBytes = (fields: WireField[] | null, field: number): Buffer | null => {
  const match = fields?.find((entry) => entry.field === field && entry.kind === 'bytes');
  return match && match.kind === 'bytes' ? match.value : null;
};

const firstVarint = (fields: WireField[] | null, field: number): number | null => {
  const match = fields?.find((entry) => entry.field === field && entry.kind === 'varint');
  return match && match.kind === 'varint' ? match.value : null;
};

// ---------------------------------------------------------------------------
// Step readers
// ---------------------------------------------------------------------------

/**
 * The prompt text of a user-input step.
 *
 * The text is stored twice — once bare at `19.2` and once wrapped in a parts
 * list at `19.3.1` — so the bare copy is preferred and the wrapped one is only
 * a fallback for a layout change.
 */
export function readUserPromptFromStep(payload: Buffer): string | null {
  const top = decodeProtobufFields(payload);
  if (!top) return null;
  if (firstVarint(top, 1) !== STEP_TYPE_USER_INPUT) return null;

  const input = firstBytes(top, FIELD_USER_INPUT);
  if (!input) return null;
  const inputFields = decodeProtobufFields(input);
  if (!inputFields) return null;

  const direct = firstBytes(inputFields, FIELD_USER_INPUT_TEXT);
  if (direct?.length) return direct.toString('utf8');

  const parts = firstBytes(inputFields, 3);
  const nested = parts ? decodeProtobufFields(parts) : null;
  const partText = firstBytes(nested, 1);
  return partText?.length ? partText.toString('utf8') : null;
}

// ---------------------------------------------------------------------------
// Conversation store
// ---------------------------------------------------------------------------

const readMetaCwd = (metaPath: string): string | null => {
  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as { cwd?: unknown };
    return typeof parsed.cwd === 'string' && parsed.cwd.trim() ? parsed.cwd : null;
  } catch {
    return null;
  }
};

/**
 * Remove CloudCLI's machine-only prompt blocks from a stored user message, so
 * neither session titles nor replayed transcripts show plumbing the user never
 * typed. Shared by the title reader and the history normalizer.
 */
export function stripAntigravityPromptPlumbing(prompt: string): string {
  return prompt
    .replace(/<workspace_boundary>[\s\S]*?<\/workspace_boundary>/g, ' ')
    .replace(/<images_input>[\s\S]*?<\/images_input>/g, ' ');
}

/**
 * Collapse a prompt into a one-line title.
 *
 * CloudCLI wraps two machine-only blocks around the user's text — an
 * `<images_input>` attachment list, and the `<workspace_boundary>` sandbox
 * briefing prepended to the first prompt of an Antigravity child. Antigravity
 * concatenates every text block of a `session/prompt` into one stored user
 * message, so both land in the transcript this title is read from; neither is
 * something to name a session after.
 */
export function antigravityTitleFromPrompt(prompt: string | null): string | null {
  if (!prompt) return null;
  const withoutPlumbing = stripAntigravityPromptPlumbing(prompt);
  const collapsed = withoutPlumbing.slice(0, MAX_TITLE_SOURCE_CHARS).replace(/\s+/g, ' ').trim();
  return collapsed ? collapsed.slice(0, 120) : null;
}

/**
 * Read one conversation's summary.
 *
 * Returns `null` when the file is absent or unreadable — a conversation being
 * written right now (WAL mid-checkpoint) must not fail a whole sync pass.
 */
export function readAntigravityConversation(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): AntigravityConversationSummary | null {
  const dir = antigravityConversationsDir(env);
  const dbPath = path.join(dir, `${sessionId}.db`);

  let stats: fs.Stats;
  try {
    stats = fs.statSync(dbPath);
  } catch {
    return null;
  }

  const summary: AntigravityConversationSummary = {
    sessionId,
    cwd: readMetaCwd(path.join(dir, `${sessionId}.meta`)),
    firstPrompt: null,
    updatedAt: stats.mtime,
    createdAt: stats.birthtime && stats.birthtime.getTime() > 0 ? stats.birthtime : stats.mtime,
    stepCount: 0,
  };

  // `readonly` is required, not merely convenient: the agent may hold the store
  // open with an active WAL, and a read-write handle would try to recover or
  // checkpoint it out from under the live session.
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });

    const promptRow = db
      .prepare('SELECT step_payload FROM steps WHERE step_type = ? ORDER BY idx ASC LIMIT 1')
      .get(STEP_TYPE_USER_INPUT) as { step_payload?: Buffer } | undefined;
    if (promptRow?.step_payload) {
      summary.firstPrompt = readUserPromptFromStep(promptRow.step_payload);
    }

    summary.stepCount = (db.prepare('SELECT COUNT(*) AS c FROM steps').get() as { c: number }).c;
  } catch {
    // A half-written or schema-shifted store still yields its mtime and cwd,
    // which is enough to index the session; only the title is lost.
    return summary;
  } finally {
    try {
      db?.close();
    } catch {
      // Already closed.
    }
  }

  return summary;
}

/** Every conversation in the store, newest write first. */
export function listAntigravityConversations(
  env: NodeJS.ProcessEnv = process.env,
  options: { since?: Date | null } = {},
): AntigravityConversationSummary[] {
  const dir = antigravityConversationsDir(env);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const since = options.since ? options.since.getTime() : null;
  const summaries: AntigravityConversationSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.db')) continue;
    const sessionId = entry.slice(0, -3);
    if (since !== null) {
      // Cheap pre-filter: skip opening stores that cannot have changed.
      try {
        if (fs.statSync(path.join(dir, entry)).mtimeMs <= since) continue;
      } catch {
        continue;
      }
    }
    const summary = readAntigravityConversation(sessionId, env);
    if (summary) summaries.push(summary);
  }

  return summaries.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}
