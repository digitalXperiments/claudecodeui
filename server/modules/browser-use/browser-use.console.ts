export type BrowserConsoleLevel = 'debug' | 'info' | 'log' | 'warn' | 'error' | 'pageerror';

export type BrowserConsoleMessage = {
  id: string;
  timestamp: string;
  level: BrowserConsoleLevel;
  text: string;
  url: string | null;
  lineNumber: number | null;
  columnNumber: number | null;
  stack: string | null;
};

export type BrowserConsoleMessageInput = Omit<BrowserConsoleMessage, 'id' | 'timestamp'> & {
  id?: string;
  timestamp?: string;
};

export type BrowserConsoleReadOptions = {
  level?: BrowserConsoleLevel;
  clear?: boolean;
};

export const DEFAULT_CONSOLE_MAX_MESSAGES = 500;
export const MAX_CONSOLE_MESSAGE_TEXT = 20_000;

function normalizeText(value: string | null | undefined): string {
  return String(value ?? '').slice(0, MAX_CONSOLE_MESSAGE_TEXT);
}

/** Bounded per-session console/page-error buffer. */
export class BrowserConsoleBuffer {
  private readonly maxMessages: number;

  private readonly messages: BrowserConsoleMessage[] = [];

  constructor(maxMessages = DEFAULT_CONSOLE_MAX_MESSAGES) {
    this.maxMessages = Math.max(1, Math.min(Math.floor(maxMessages), 5_000));
  }

  add(input: BrowserConsoleMessageInput): BrowserConsoleMessage {
    const message: BrowserConsoleMessage = {
      id: input.id || `${Date.now()}-${this.messages.length + 1}`,
      timestamp: input.timestamp || new Date().toISOString(),
      level: input.level,
      text: normalizeText(input.text),
      url: input.url || null,
      lineNumber: typeof input.lineNumber === 'number' ? input.lineNumber : null,
      columnNumber: typeof input.columnNumber === 'number' ? input.columnNumber : null,
      stack: input.stack ? normalizeText(input.stack) : null,
    };
    this.messages.push(message);
    if (this.messages.length > this.maxMessages) {
      this.messages.splice(0, this.messages.length - this.maxMessages);
    }
    return { ...message };
  }

  read(options: BrowserConsoleReadOptions = {}): BrowserConsoleMessage[] {
    const level = options.level;
    const result = this.messages
      .filter((message) => !level || message.level === level)
      .map((message) => ({ ...message }));
    if (options.clear === true) {
      this.messages.length = 0;
    }
    return result;
  }

  clear(): number {
    const count = this.messages.length;
    this.messages.length = 0;
    return count;
  }

  get size(): number {
    return this.messages.length;
  }
}

export function normalizeConsoleLevel(value: string): BrowserConsoleLevel {
  switch (value.toLowerCase()) {
    case 'debug':
      return 'debug';
    case 'info':
      return 'info';
    case 'warn':
    case 'warning':
      return 'warn';
    case 'error':
      return 'error';
    case 'pageerror':
      return 'pageerror';
    case 'log':
    default:
      return 'log';
  }
}

