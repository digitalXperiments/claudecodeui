import { randomUUID } from 'node:crypto';

export const DEFAULT_HUMAN_PROMPT_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_HUMAN_PROMPT_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_SECRET_HANDLE_TTL_MS = 5 * 60 * 1000;

export type BrowserHumanPrompt = {
  id: string;
  sessionId: string | null;
  prompt: string;
  choices: string[];
  secret: boolean;
  createdAt: string;
  expiresAt: string;
};

export type BrowserHumanPromptResult = {
  promptId: string;
  secret: boolean;
  answered: boolean;
  timedOut?: boolean;
  value?: string;
  secretHandle?: string;
  confirmation?: string;
};

export type BrowserHumanPromptAnswer = {
  accepted: true;
  promptId: string;
  secret: boolean;
  secretHandle?: string;
};

type PendingPrompt = {
  prompt: BrowserHumanPrompt;
  resolve: (result: BrowserHumanPromptResult) => void;
  timer: ReturnType<typeof setTimeout>;
  notificationId?: string;
};

type SecretHandle = {
  value: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
};

export type CreateBrowserHumanPromptInput = {
  prompt: string;
  sessionId?: string | null;
  choices?: string[];
  secret?: boolean;
  timeoutMs?: number;
};

export type PendingInputStoreOptions = {
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  secretHandleTtlMs?: number;
  createId?: () => string;
  /** Keep timers from preventing a host process from shutting down. */
  unrefTimers?: boolean;
  onCreated?: (prompt: BrowserHumanPrompt) => void;
  onCompleted?: (prompt: BrowserHumanPrompt) => void;
};

function normalizeChoices(choices: string[] | undefined): string[] {
  if (!Array.isArray(choices)) {
    return [];
  }

  return choices
    .filter((choice): choice is string => typeof choice === 'string')
    .map((choice) => choice.trim().slice(0, 200))
    .filter(Boolean)
    .slice(0, 20);
}

function normalizeTimeout(value: number | undefined, defaultTimeoutMs: number, maxTimeoutMs: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return defaultTimeoutMs;
  }
  return Math.max(1, Math.min(Math.floor(value), maxTimeoutMs));
}

/**
 * In-memory state machine for agent-to-human prompts.
 *
 * Secret answers are converted into one-shot handles before the result is
 * resolved. The raw value never appears in a public prompt, completion, or
 * answer result and is removed as soon as the handle is consumed or expires.
 */
export class PendingInputStore {
  private readonly pending = new Map<string, PendingPrompt>();

  private readonly secretHandles = new Map<string, SecretHandle>();

  private readonly defaultTimeoutMs: number;

  private readonly maxTimeoutMs: number;

  private readonly secretHandleTtlMs: number;

  private readonly createId: () => string;

  private readonly unrefTimers: boolean;

  private readonly onCreated?: (prompt: BrowserHumanPrompt) => void;

  private readonly onCompleted?: (prompt: BrowserHumanPrompt) => void;

  constructor(options: PendingInputStoreOptions = {}) {
    this.defaultTimeoutMs = normalizeTimeout(
      options.defaultTimeoutMs,
      DEFAULT_HUMAN_PROMPT_TIMEOUT_MS,
      MAX_HUMAN_PROMPT_TIMEOUT_MS,
    );
    this.maxTimeoutMs = Math.max(this.defaultTimeoutMs, Math.min(
      options.maxTimeoutMs ?? MAX_HUMAN_PROMPT_TIMEOUT_MS,
      MAX_HUMAN_PROMPT_TIMEOUT_MS,
    ));
    this.secretHandleTtlMs = Math.max(1, Math.min(
      Math.floor(options.secretHandleTtlMs ?? DEFAULT_SECRET_HANDLE_TTL_MS),
      MAX_HUMAN_PROMPT_TIMEOUT_MS,
    ));
    this.createId = options.createId ?? randomUUID;
    this.unrefTimers = options.unrefTimers === true;
    this.onCreated = options.onCreated;
    this.onCompleted = options.onCompleted;
  }

  create(input: CreateBrowserHumanPromptInput): {
    prompt: BrowserHumanPrompt;
    result: Promise<BrowserHumanPromptResult>;
  } {
    const promptText = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (!promptText) {
      throw new Error('prompt is required.');
    }

    const now = Date.now();
    const timeoutMs = normalizeTimeout(input.timeoutMs, this.defaultTimeoutMs, this.maxTimeoutMs);
    const prompt: BrowserHumanPrompt = {
      id: this.createId(),
      sessionId: typeof input.sessionId === 'string' && input.sessionId.trim() ? input.sessionId.trim() : null,
      prompt: promptText.slice(0, 4_000),
      choices: normalizeChoices(input.choices),
      secret: input.secret === true,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + timeoutMs).toISOString(),
    };

    let resolveResult!: (result: BrowserHumanPromptResult) => void;
    const result = new Promise<BrowserHumanPromptResult>((resolve) => {
      resolveResult = resolve;
    });
    const timer = setTimeout(() => {
      this.completeTimeout(prompt.id);
    }, timeoutMs);
    if (this.unrefTimers) {
      timer.unref?.();
    }

    this.pending.set(prompt.id, { prompt, resolve: resolveResult, timer });
    this.onCreated?.(prompt);
    return { prompt: { ...prompt, choices: [...prompt.choices] }, result };
  }

  list(sessionId?: string): BrowserHumanPrompt[] {
    this.expire(Date.now());
    return [...this.pending.values()]
      .filter((entry) => !sessionId || entry.prompt.sessionId === sessionId)
      .map((entry) => ({ ...entry.prompt, choices: [...entry.prompt.choices] }));
  }

  setNotificationId(promptId: string, notificationId: string): boolean {
    const entry = this.pending.get(promptId);
    if (!entry) {
      return false;
    }
    entry.notificationId = notificationId;
    return true;
  }

  getNotificationId(promptId: string): string | undefined {
    return this.pending.get(promptId)?.notificationId;
  }

  answer(promptId: string, value: string): BrowserHumanPromptAnswer | null {
    const entry = this.pending.get(promptId);
    if (!entry) {
      this.expire(Date.now());
      return null;
    }

    const answer = typeof value === 'string' ? value : '';
    this.pending.delete(promptId);
    clearTimeout(entry.timer);
    this.onCompleted?.(entry.prompt);

    if (entry.prompt.secret) {
      const secretHandle = this.createId();
      const expiresAt = Date.now() + this.secretHandleTtlMs;
      const timer = setTimeout(() => {
        this.secretHandles.delete(secretHandle);
      }, this.secretHandleTtlMs);
      if (this.unrefTimers) {
        timer.unref?.();
      }
      this.secretHandles.set(secretHandle, { value: answer, expiresAt, timer });
      entry.resolve({
        promptId,
        secret: true,
        answered: true,
        secretHandle,
        confirmation: 'Human input received. Use the one-shot secret handle immediately.',
      });
      return { accepted: true, promptId, secret: true, secretHandle };
    }

    entry.resolve({ promptId, secret: false, answered: true, value: answer });
    return { accepted: true, promptId, secret: false };
  }

  consumeSecretHandle(secretHandle: string): string | null {
    const entry = this.secretHandles.get(secretHandle);
    if (!entry) {
      return null;
    }
    this.secretHandles.delete(secretHandle);
    clearTimeout(entry.timer);
    if (entry.expiresAt <= Date.now()) {
      return null;
    }
    return entry.value;
  }

  expire(now = Date.now()): void {
    for (const [promptId, entry] of this.pending) {
      if (Date.parse(entry.prompt.expiresAt) <= now) {
        this.completeTimeout(promptId);
      }
    }
  }

  clear(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
    }
    this.pending.clear();
    for (const entry of this.secretHandles.values()) {
      clearTimeout(entry.timer);
    }
    this.secretHandles.clear();
  }

  private completeTimeout(promptId: string): void {
    const entry = this.pending.get(promptId);
    if (!entry) {
      return;
    }
    this.pending.delete(promptId);
    clearTimeout(entry.timer);
    this.onCompleted?.(entry.prompt);
    entry.resolve({
      promptId,
      secret: entry.prompt.secret,
      answered: false,
      timedOut: true,
    });
  }
}
