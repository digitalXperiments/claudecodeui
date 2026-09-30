/**
 * Teach mode: the operator demonstrates a browser workflow once, CloudCLI records it and drafts a
 * SKILL.md the bot can repeat.
 *
 * start: opens a cloudcli-browser session (on the bot's own persistent profile, so a login made
 * during the demonstration is kept for the bot), starts the semantic action recorder and hands the
 * operator the controls (they drive it from the Browser panel).
 * stop: collects the recorded navigations, clicks, typed fields, selects and Enter presses, closes
 * the session, and saves a DISABLED draft skill with origin 'teach'.
 */
import { browserUseService } from '@/modules/browser-use/index.js';
import type { RecordedAction } from '@/modules/browser-use/index.js';
import { missionControlDb } from '@/modules/mission-control/index.js';
import { AppError } from '@/shared/utils.js';

import { resolveBotBrowserProfileDir } from '../bots-home.js';
import { skills } from '../learning/index.js';

import { compileTeachSkill, type CompileOptions, type TeachInput, type TeachStep } from './teach-compile.js';

/** The slice of browser-use teach mode needs (a fake in tests). */
export interface TeachBrowser {
  createAgentSession(options: { profileDir?: string | null; recordNetwork?: boolean }): Promise<{ id: string; status: string; message: string | null }>;
  agentNavigate(sessionId: string, url: string): Promise<unknown>;
  startActionRecording(sessionId: string): Promise<unknown>;
  stopActionRecording(sessionId: string): Promise<{ actions: RecordedAction[]; startedAt: number; stoppedAt: number }>;
  takeHumanControl(sessionId: string): Promise<unknown>;
  returnAgentControl(sessionId: string): Promise<unknown>;
  stopSession(sessionId: string): Promise<unknown>;
}

export interface TeachDeps {
  browser: TeachBrowser;
  saveSkill: (botId: string, input: { name: string; content: string; description: string; origin: string; enabled: boolean }) => { name: string };
  listSkillNames: (botId: string) => string[];
}

const defaultDeps = (): TeachDeps => ({
  browser: browserUseService as unknown as TeachBrowser,
  saveSkill: (botId, input) => skills.save(botId, input),
  listSkillNames: (botId) => skills.list(botId).map((skill) => skill.name),
});

let deps: TeachDeps | null = null;

/** Tests inject a fake browser and skill store; null restores the real ones. */
export function setTeachDeps(next: Partial<TeachDeps> | null): void {
  deps = next ? { ...defaultDeps(), ...next } : null;
}

const active = new Map<string, { sessionId: string; startedAt: string; startUrl: string | null }>();

/** Drop all teach state (tests). */
export function resetTeachState(): void {
  active.clear();
}

export function activeTeachSession(botId: string): { sessionId: string; startedAt: string; startUrl: string | null } | null {
  return active.get(botId) ?? null;
}

const teachError = (message: string, statusCode: number, code: string): AppError => new AppError(message, { code, statusCode });

function requireBot(botId: string): void {
  if (!missionControlDb.getSection(botId)) throw teachError('Bot not found', 404, 'BOT_NOT_FOUND');
}

function httpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString();
  } catch {
    // fall through
  }
  throw teachError('url must be an http(s) URL', 400, 'TEACH_INVALID_URL');
}

export interface TeachStartResult {
  sessionId: string;
  startedAt: string;
  startUrl: string | null;
  profile: 'bot' | 'temporary';
  note: string;
}

export async function startTeach(botId: string, input: { url?: unknown; useBotProfile?: unknown } = {}): Promise<TeachStartResult> {
  requireBot(botId);
  if (active.has(botId)) throw teachError('A teach session is already running for this bot. Stop it first.', 409, 'TEACH_IN_PROGRESS');
  const url = httpUrl(input.url);
  const { browser } = deps ?? defaultDeps();
  const useProfile = input.useBotProfile !== false;

  let session: Awaited<ReturnType<TeachBrowser['createAgentSession']>>;
  try {
    session = await browser.createAgentSession({ profileDir: useProfile ? resolveBotBrowserProfileDir(botId) : null, recordNetwork: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A profile in use by a running bot session is the usual cause; say so.
    throw teachError(`Could not open the browser: ${message}`, 409, 'TEACH_BROWSER_UNAVAILABLE');
  }
  if (session.status !== 'ready') {
    throw teachError(session.message || 'The browser runtime is not ready.', 503, 'TEACH_BROWSER_UNAVAILABLE');
  }
  try {
    if (url) await browser.agentNavigate(session.id, url);
    await browser.startActionRecording(session.id);
    await browser.takeHumanControl(session.id);
  } catch (error) {
    await browser.stopSession(session.id).catch(() => undefined);
    throw teachError(`Could not start teach mode: ${error instanceof Error ? error.message : String(error)}`, 500, 'TEACH_START_FAILED');
  }
  const startedAt = new Date().toISOString();
  active.set(botId, { sessionId: session.id, startedAt, startUrl: url });
  return {
    sessionId: session.id,
    startedAt,
    startUrl: url,
    profile: useProfile ? 'bot' : 'temporary',
    note: 'Open the Browser panel and do the task once. Call stop when you are done; typed values are not saved.',
  };
}

export interface TeachStopInput extends CompileOptions {
  /** Do not save a skill; just return the compiled steps. */
  dryRun?: boolean;
}

export interface TeachStopResult {
  skill: { name: string; enabled: boolean; origin: string } | null;
  name: string;
  content: string;
  steps: TeachStep[];
  inputs: TeachInput[];
  captured: { actions: number; skipped: number };
  /** Exactly what teach mode records. */
  capturedKinds: string[];
}

export const TEACH_CAPTURES = [
  'page navigations (http/https; query and fragment dropped)',
  'clicks (visible text and a selector)',
  'Enter presses',
  'field interactions: a selector and label only; values are redacted into inputs unless marked safe, password-like fields are never captured',
  'select choices (redacted the same way)',
];

function uniqueName(base: string, taken: string[]): string {
  let name = base;
  for (let i = 2; taken.includes(name); i += 1) name = `${base.slice(0, 58)}-${i}`;
  return name;
}

export async function stopTeach(botId: string, input: TeachStopInput = {}): Promise<TeachStopResult> {
  requireBot(botId);
  const current = active.get(botId);
  if (!current) throw teachError('No teach session is running for this bot', 404, 'TEACH_NOT_ACTIVE');
  const { browser, saveSkill, listSkillNames } = deps ?? defaultDeps();

  let recorded: { actions: RecordedAction[]; startedAt: number; stoppedAt: number };
  try {
    recorded = await browser.stopActionRecording(current.sessionId);
  } catch (error) {
    throw teachError(`Could not collect the recording: ${error instanceof Error ? error.message : String(error)}`, 500, 'TEACH_STOP_FAILED');
  } finally {
    active.delete(botId);
    await browser.returnAgentControl(current.sessionId).catch(() => undefined);
    // Close the session so the bot's profile is unlocked for its next run.
    await browser.stopSession(current.sessionId).catch(() => undefined);
  }

  const compileOptions: CompileOptions = {
    safeSteps: Array.isArray(input.safeSteps) ? input.safeSteps.filter((n) => Number.isInteger(n)) : undefined,
    safeFields: Array.isArray(input.safeFields) ? input.safeFields.filter((f) => typeof f === 'string') : undefined,
    name: input.name,
    description: input.description,
    successCheck: input.successCheck,
    startUrl: current.startUrl ?? undefined,
  };
  const compiled = compileTeachSkill(recorded.actions, compileOptions);
  if (compiled.steps.length === 0) {
    throw teachError('Nothing was recorded. Interact with the page in the Browser panel, then stop again.', 422, 'TEACH_EMPTY');
  }

  let skill: TeachStopResult['skill'] = null;
  let name = compiled.name;
  let content = compiled.content;
  if (!input.dryRun) {
    name = uniqueName(compiled.name, listSkillNames(botId));
    if (name !== compiled.name) content = content.replace(/^name: .*$/m, `name: ${name}`);
    const saved = saveSkill(botId, { name, content, description: compiled.description, origin: 'teach', enabled: false });
    skill = { name: saved.name, enabled: false, origin: 'teach' };
  }
  return {
    skill,
    name,
    content,
    steps: compiled.steps,
    inputs: compiled.inputs,
    captured: { actions: recorded.actions.length, skipped: compiled.skipped },
    capturedKinds: TEACH_CAPTURES,
  };
}
