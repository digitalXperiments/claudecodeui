/**
 * Fast page-state answers for the browser tools.
 *
 * The driving agent used to learn what an action did the expensive way: call
 * the action (which returned only url/title/screenshot), then call
 * `browser_snapshot` for up to 30,000 characters of page text, then spend a
 * whole model turn deciding "did that work, and is the page ready yet?".
 *
 * Those are two bounded questions. Answering them here — in the same tool call
 * that performed the action — removes a model turn and a 30k-character payload
 * from every step. Jev never chooses *what to do next*; it only reports what
 * just happened, and the agent still drives.
 *
 * With the capability off, nothing here runs and every tool returns exactly
 * what it returned before.
 */

import {
  askJev,
  capabilityMode,
  readJevSettings,
  type JevDecision,
} from '@/modules/decisioning/index.js';

/** Enough text to classify a page; a small fraction of a full snapshot. */
const STATE_TEXT_CHARS = 4_000;
/** Hard bound: this runs inline in a tool call, so it must never stall one. */
const STATE_TIMEOUT_MS = 2_500;

export type BrowserPageState =
  /** Loaded, settled, and showing the content the action was meant to produce. */
  | 'ready'
  /** Still loading — spinners, skeletons, or an empty shell. */
  | 'loading'
  /** A consent/cookie/newsletter dialog is covering the content. */
  | 'blocked_by_dialog'
  /** An error page: 404, 500, network failure, "something went wrong". */
  | 'error'
  /** A sign-in wall, or a captcha/verification challenge. */
  | 'needs_human';

export type BrowserPageAssessment = {
  state: BrowserPageState;
  confidence: number;
  /** Probability the action that just ran actually changed the page. */
  actionTookEffect: number;
  latencyMs: number;
  /** Non-null when the call failed; the tool then reports no assessment. */
  error: string | null;
};

/** Cheap gate so callers can skip reading page text when the sidecar is off. */
export function browserPageStateEnabled(): boolean {
  return capabilityMode(readJevSettings(), 'browser_page_state') !== 'off';
}

export type AssessPageInput = {
  /** The tool that just ran, e.g. `click`, `type`, `navigate`. */
  action: string;
  url: string;
  title: string;
  /** Visible page text. Clipped here — callers may pass the full snapshot. */
  text: string;
  /** Page text from before the action, so "did anything change" is answerable. */
  previousText?: string | null;
};

function clip(value: string | null | undefined, max: number): string {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * Returns `null` whenever the capability is off, unconfigured, or the call
 * failed — callers then behave exactly as they did before Jev existed.
 */
export async function assessPageState(
  input: AssessPageInput,
): Promise<BrowserPageAssessment | null> {
  const settings = readJevSettings();
  if (capabilityMode(settings, 'browser_page_state') === 'off') return null;

  const before = clip(input.previousText, 600);
  const decision: JevDecision<BrowserPageState> | null = await askJev(settings, {
    capability: 'browser_page_state',
    fallbackVerdict: 'ready',
    verdicts: ['ready', 'loading', 'blocked_by_dialog', 'error', 'needs_human'] as const,
    maxTimeoutMs: STATE_TIMEOUT_MS,
    verdictInstructions:
      'A browser automation step just ran and this is the resulting page. Report what state the page is '
      + 'in now. Do not decide what to do next.',
    verdictCriteria: {
      ready: 'Loaded and settled, showing real content the agent can act on.',
      loading: 'Still loading — a spinner, skeleton placeholders, or an empty shell.',
      blocked_by_dialog:
        'A cookie/consent banner, newsletter popup, or similar overlay is covering the content.',
      error: 'An error page: not found, server error, network failure, or an explicit failure message.',
      needs_human: 'A sign-in wall, captcha, or verification challenge that automation cannot pass.',
    },
    signals: {
      action_took_effect: 'The page changed as a result of the step that just ran, rather than staying as it was.',
    },
    state: {
      justRan: input.action,
      url: input.url,
      title: clip(input.title, 300),
      pageTextBefore: before || null,
      pageTextNow: clip(input.text, STATE_TEXT_CHARS),
    },
  });

  if (!decision) return null;
  return {
    state: decision.verdict,
    confidence: decision.confidence,
    actionTookEffect: decision.signals.action_took_effect ?? 0,
    latencyMs: decision.latencyMs,
    error: decision.error,
  };
}
