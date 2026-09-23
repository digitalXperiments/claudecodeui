import fs from 'node:fs';

import { sessionsDb } from '@/modules/database/index.js';
import { broadcastSessionRemoved } from '@/modules/websocket/index.js';

/**
 * Allowance for clock skew and transcript write lag when matching provider
 * sessions to the lifetime of a shell PTY.
 */
export const SHELL_ADOPTION_SKEW_MS = 15_000;

/**
 * Shortest typed prompt (after whitespace normalization) that counts as
 * evidence a transcript belongs to a PTY. Shorter lines ("y", "ok", "hi")
 * appear in countless transcripts and prove nothing.
 */
export const MIN_SHELL_PROMPT_EVIDENCE_CHARS = 6;

/** Largest transcript scanned for prompt evidence. */
const MAX_EVIDENCE_FILE_BYTES = 32 * 1024 * 1024;

export type ShellSessionAdoptionResult = {
  /** Canonical app session id to broadcast a session_upserted for. */
  appSessionId: string;
  providerSessionId: string | null;
  /** True when this call changed the app↔provider mapping. */
  adopted: boolean;
};

/**
 * The strongest single-line fragment of each prompt typed into the PTY that
 * is usable as evidence: whitespace-collapsed, long enough to be distinctive,
 * and not a TUI slash command (those are not stored as prompt text).
 */
export function shellPromptEvidence(submittedPrompts: readonly string[] | undefined): string[] {
  const fragments = new Set<string>();
  for (const prompt of submittedPrompts ?? []) {
    if (typeof prompt !== 'string' || prompt.trim().startsWith('/')) {
      continue;
    }
    const longest = prompt
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .reduce((best, line) => (line.length > best.length ? line : best), '');
    if (longest.length >= MIN_SHELL_PROMPT_EVIDENCE_CHARS) {
      fragments.add(longest);
    }
  }
  return [...fragments];
}

/**
 * True when `text` (raw transcript bytes: JSONL, or a JSON column) contains
 * one of the evidence fragments — verbatim, JSON-escaped, or double-escaped
 * (OpenCode stores some prompts as a JSON string literal inside JSON).
 */
export function textContainsShellPrompt(text: string, evidence: readonly string[]): boolean {
  if (!text) {
    return false;
  }
  return evidence.some((fragment) => {
    const escaped = JSON.stringify(fragment).slice(1, -1);
    const doubleEscaped = JSON.stringify(escaped).slice(1, -1);
    return text.includes(fragment) || text.includes(escaped) || text.includes(doubleEscaped);
  });
}

/** Reads one transcript file (bounded) and checks it for prompt evidence. */
export function fileContainsShellPrompt(filePath: string, evidence: readonly string[]): boolean {
  if (evidence.length === 0) {
    return false;
  }
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_EVIDENCE_FILE_BYTES) {
      return false;
    }
    return textContainsShellPrompt(fs.readFileSync(filePath, 'utf8'), evidence);
  } catch {
    return false;
  }
}

/**
 * Binds a provider session the interactive Shell TUI created back onto the
 * app session, so Chat and Shell stay on ONE transcript.
 *
 * `candidates` are provider-native ids CREATED while the PTY was alive in the
 * same project (bounded by spawn and exit/adoption time), newest first,
 * already indexed by the provider synchronizer. Binding a wrong session is
 * far worse than binding none, so the rules are conservative:
 *
 * - app row already mapped: never remap (that mapping came from the provider
 *   runtime itself); still report it so the caller broadcasts an upsert and
 *   open chat views refetch turns the shell just wrote;
 * - app row unmapped: bind only when exactly ONE candidate
 *   1. is not owned by another app row — a disk-indexed placeholder row
 *      (session_id === provider_session_id) is only disregarded when the
 *      provider session itself began after the PTY spawned, so a session that
 *      existed (and was indexed) before this PTY is never merged away; and
 *   2. contains a prompt that was typed into THIS PTY (`hasPromptEvidence`).
 *   An external CLI or a concurrent Chatbar run in the same project never
 *   carries this PTY's prompts, so it is never adopted. No usable prompt, or
 *   more than one match, leaves the row unbound;
 * - no app row (shell opened on an unsent "new chat"): the synchronizer has
 *   already indexed the TUI session as its own sidebar row; report the one
 *   carrying this PTY's prompt (else the newest) so the sidebar refreshes.
 *   Nothing is written in this case.
 */
export function adoptShellCreatedSession(info: {
  provider: string;
  appSessionId: string | null;
  candidates: string[];
  /** When the shell PTY spawned (epoch ms). */
  startedAt: number;
  /** Prompts submitted into the PTY (see the shell websocket input tracker). */
  submittedPrompts?: readonly string[];
  /** Whether one candidate's transcript contains any of the evidence fragments. */
  hasPromptEvidence: (candidateId: string, evidence: readonly string[]) => boolean;
}): ShellSessionAdoptionResult | null {
  const { provider, appSessionId, candidates, startedAt } = info;
  const appRow = appSessionId ? sessionsDb.getSessionById(appSessionId) : null;
  const evidence = shellPromptEvidence(info.submittedPrompts);

  if (appRow) {
    if (appRow.provider !== provider) {
      return null;
    }
    if (appRow.provider_session_id) {
      return {
        appSessionId: appRow.session_id,
        providerSessionId: appRow.provider_session_id,
        adopted: false,
      };
    }
    if (evidence.length === 0) {
      return null;
    }

    const eligible = candidates.filter((candidateId) => {
      const owner = sessionsDb.getSessionByProviderSessionId(candidateId, provider);
      if (owner && owner.session_id !== appRow.session_id) {
        const isPlaceholder = owner.session_id === owner.provider_session_id
          && !owner.is_internal
          && !owner.isArchived;
        const ownerCreatedAt = Date.parse(owner.created_at);
        // Floor to the second: CURRENT_TIMESTAMP-created rows carry no ms.
        if (!isPlaceholder || !Number.isFinite(ownerCreatedAt) || ownerCreatedAt < Math.floor(startedAt / 1000) * 1000) {
          return false;
        }
      }
      return info.hasPromptEvidence(candidateId, evidence);
    });
    if (eligible.length !== 1) {
      return null;
    }
    const providerSessionId = eligible[0]!;
    const mapping = sessionsDb.assignProviderSessionId(appRow.session_id, providerSessionId);
    if (mapping.deletedSessionId && mapping.deletedSessionId !== appRow.session_id) {
      broadcastSessionRemoved(mapping.deletedSessionId);
    }
    console.info(
      `[shell-session-adoption] Adopted shell-created ${provider} session ${providerSessionId} ` +
      `onto app session ${appRow.session_id}`,
    );
    return { appSessionId: appRow.session_id, providerSessionId, adopted: true };
  }

  const indexed = candidates.filter((candidateId) => sessionsDb.getSessionByProviderSessionId(candidateId, provider));
  const reported = (evidence.length > 0
    ? indexed.find((candidateId) => info.hasPromptEvidence(candidateId, evidence))
    : undefined) ?? indexed[0];
  if (!reported) {
    return null;
  }
  const row = sessionsDb.getSessionByProviderSessionId(reported, provider);
  return row
    ? { appSessionId: row.session_id, providerSessionId: reported, adopted: false }
    : null;
}
