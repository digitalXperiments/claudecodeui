/**
 * Compile plain-English permission intents into allow/deny rules using Claude.
 *
 * Uses a short, tool-free Agent SDK query (Haiku by default) so it reuses the
 * user's existing Claude auth — no separate API key wiring. Falls back to the
 * local keyword mapper only when Claude is unavailable or returns unusable JSON.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';

import { compilePermissionIntent } from '@/modules/database/index.js';
import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';

export type CompiledPermissions = {
  allowedCommands: string[];
  disallowedCommands: string[];
  suggestedMode: string | null;
};

export type CompilePermissionsResult = CompiledPermissions & {
  /** How the rules were produced. */
  source: 'claude' | 'fallback';
  /** Human-readable note for the UI. */
  note?: string;
};

const VALID_MODES = new Set([
  'default',
  'plan',
  'acceptEdits',
  'auto',
  'bypassPermissions',
]);

const COMPILE_MODEL = process.env.CLOUDCLI_PERMISSION_COMPILE_MODEL?.trim() || 'haiku';
const COMPILE_TIMEOUT_MS = Number(process.env.CLOUDCLI_PERMISSION_COMPILE_TIMEOUT_MS) || 45_000;

const SYSTEM_INSTRUCTIONS = `You convert plain-English security policies for coding agents into concrete tool permission rules.

Return ONLY a single JSON object (no markdown fences, no commentary) with this shape:
{
  "allowedCommands": string[],
  "disallowedCommands": string[],
  "suggestedMode": "default" | "plan" | "acceptEdits" | "auto" | "bypassPermissions" | null,
  "rationale": string
}

Rule syntax (Claude Code / Cursor-style tool prefixes):
- Tools: Read, Write, Edit, MultiEdit, Glob, Grep, Bash, WebFetch, WebSearch, TodoRead, TodoWrite, Task
- Shell patterns: Bash(git*), Bash(npm*), Bash(rm*), Bash(curl*), Shell(ls) for Cursor-style
- Prefer broad safe globs for intended work (e.g. Bash(git*), Bash(npm test*))
- Prefer explicit denies for destructive/network ops when the user asks (Bash(rm*), Bash(sudo*), Bash(curl*), WebFetch)

Modes:
- plan: read-only / planning
- acceptEdits: auto-accept file edits
- auto: autonomous with allow list
- bypassPermissions: unrestricted (only if user clearly wants full access)
- default: normal guarded interactive mode
- null: leave mode unchanged

Be conservative: if unsure whether something is allowed, omit it rather than over-allowing.`;

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  // Strip optional markdown fences.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    // Find first {...} block.
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error('No JSON object in model response');
  }
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

function normalizeCompiled(raw: unknown): CompiledPermissions | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const allowedCommands = normalizeStringList(obj.allowedCommands ?? obj.allowed);
  const disallowedCommands = normalizeStringList(obj.disallowedCommands ?? obj.disallowed);
  let suggestedMode: string | null = null;
  if (typeof obj.suggestedMode === 'string' && VALID_MODES.has(obj.suggestedMode)) {
    suggestedMode = obj.suggestedMode;
  } else if (obj.suggestedMode === null) {
    suggestedMode = null;
  }
  // Accept empty lists only if we got a parseable object (model may return empty).
  return { allowedCommands, disallowedCommands, suggestedMode };
}

function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const msg = message as Record<string, unknown>;

  // SDK result messages often carry result as string.
  if (msg.type === 'result' && typeof msg.result === 'string') {
    return msg.result;
  }
  if (typeof msg.result === 'string') {
    return msg.result;
  }

  // Assistant message content blocks.
  const content = msg.message && typeof msg.message === 'object'
    ? (msg.message as Record<string, unknown>).content
    : msg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object') {
          const b = block as Record<string, unknown>;
          if (typeof b.text === 'string') return b.text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

/**
 * Ask Claude to compile an intent. Throws on hard failures (timeout, auth, empty).
 */
async function runClaudeCompile(intent: string): Promise<CompiledPermissions & { rationale?: string }> {
  const prompt = `${SYSTEM_INSTRUCTIONS}

User intent:
"""
${intent}
"""

Respond with JSON only.`;

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), COMPILE_TIMEOUT_MS);

  try {
    const q = query({
      prompt,
      options: {
        abortController,
        env: { ...process.env },
        pathToClaudeCodeExecutable: resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH),
        model: COMPILE_MODEL,
        // No tools — pure text generation.
        tools: [],
        allowedTools: [],
        permissionMode: 'bypassPermissions',
        maxTurns: 1,
        // Avoid project settings side-effects for this ephemeral call.
        settingSources: [],
        systemPrompt: 'You are a precise permissions compiler. Output only valid JSON as instructed.',
      },
    });

    let lastText = '';
    for await (const message of q) {
      const text = extractAssistantText(message);
      if (text.trim()) {
        lastText = text;
      }
    }

    if (!lastText.trim()) {
      throw new Error('Claude returned an empty response');
    }

    const parsed = extractJsonObject(lastText);
    const normalized = normalizeCompiled(parsed);
    if (!normalized) {
      throw new Error('Claude response was not valid permission JSON');
    }

    const rationale =
      parsed && typeof parsed === 'object' && typeof (parsed as { rationale?: unknown }).rationale === 'string'
        ? (parsed as { rationale: string }).rationale
        : undefined;

    return { ...normalized, rationale };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Compile plain-English permissions: Claude first, keyword fallback second.
 */
export async function compilePermissionsWithClaude(intent: string): Promise<CompilePermissionsResult> {
  const trimmed = intent.trim();
  if (!trimmed) {
    return {
      allowedCommands: [],
      disallowedCommands: [],
      suggestedMode: null,
      source: 'fallback',
      note: 'Empty intent — nothing to compile.',
    };
  }

  try {
    const result = await runClaudeCompile(trimmed);
    const allowCount = result.allowedCommands.length;
    const denyCount = result.disallowedCommands.length;
    const modeBit = result.suggestedMode ? ` Suggested mode: ${result.suggestedMode}.` : '';
    const rationaleBit = result.rationale ? ` ${result.rationale}` : '';
    return {
      allowedCommands: result.allowedCommands,
      disallowedCommands: result.disallowedCommands,
      suggestedMode: result.suggestedMode,
      source: 'claude',
      note:
        allowCount === 0 && denyCount === 0
          ? `Claude found no specific rules.${modeBit}${rationaleBit}`.trim()
          : `Claude compiled → ${allowCount} allow, ${denyCount} deny.${modeBit}${rationaleBit}`.trim(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[agent-profiles] Claude permission compile failed, using keyword fallback:', message);
    const fallback = compilePermissionIntent(trimmed);
    const allowCount = fallback.allowedCommands.length;
    const denyCount = fallback.disallowedCommands.length;
    return {
      ...fallback,
      source: 'fallback',
      note:
        allowCount === 0 && denyCount === 0
          ? `Claude unavailable (${message}). Keyword fallback also found no matches — try clearer intent or sign in to Claude.`
          : `Claude unavailable (${message}). Used keyword fallback → ${allowCount} allow, ${denyCount} deny. Review carefully.`,
    };
  }
}
