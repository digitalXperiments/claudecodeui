/**
 * Classify interactive agent TUI frames as busy vs idle.
 *
 * A live PTY is not the same as a running turn. Claude / Grok / Codex / Cursor
 * keep the process open at an idle prompt (`>` / `❯`) after the model stops.
 * Chatbar "processing" must follow the TUI's current turn, not PTY lifetime.
 */

export type TuiActivity = 'busy' | 'idle' | 'unknown';

const BRAILLE_SPINNER = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]/;

const BUSY_PATTERNS: readonly RegExp[] = [
  /esc to interrupt/i,
  /ctrl\s*\+\s*c to interrupt/i,
  /\bthinking\b/i,
  /\banalyzi(?:ng|e)\b/i,
  /\breasoning\b/i,
  /\bcomputing\b/i,
  /\bworking(?:\s+on)?\b/i,
  /\bcompacting\b/i,
  /auto-compact/i,
  /\bgenerating\b/i,
  /\brunning (?:bash|command|tool)\b/i,
];

const IDLE_CHROME: readonly RegExp[] = [
  /shift\s*\+\s*tab/i,
  /ctrl\s*\+\s*x/i,
  /\? for shortcuts/i,
  /ctrl\s*\+\s*g to edit/i,
  /tab to accept/i,
];

const IDLE_PROMPT = /(?:^|[\n\r])\s*[❯>]\s*$/m;

const TAIL_CHARS = 2500;

/**
 * Inspect the tail of a stripped (no ANSI) TUI buffer.
 * Full-screen CLIs redraw often, so the latest screen is the signal.
 */
export function classifyTuiActivity(strippedText: string): TuiActivity {
  if (!strippedText) {
    return 'unknown';
  }

  const tail = strippedText.slice(-TAIL_CHARS);
  const strongBusy =
    /esc to interrupt/i.test(tail)
    || /ctrl\s*\+\s*c to interrupt/i.test(tail)
    || BRAILLE_SPINNER.test(tail);
  const busy = strongBusy || BUSY_PATTERNS.some((pattern) => pattern.test(tail));
  const idleChrome = IDLE_CHROME.some((pattern) => pattern.test(tail));
  const idlePrompt = IDLE_PROMPT.test(tail);

  // Interrupt affordances mean a turn is live even if a prompt glyph is on screen.
  if (strongBusy) {
    return 'busy';
  }

  // Full-screen TUIs keep transcript text (including old "Thinking") while idle.
  // Shortcut chrome / a lone prompt is the current-frame signal.
  if (idleChrome || idlePrompt) {
    return 'idle';
  }

  if (busy) {
    return 'busy';
  }

  return 'unknown';
}

/** True when the user submitted a line to the TUI (Enter), not a lone key. */
export function isTuiSubmitInput(data: string): boolean {
  return data.includes('\r') || data.includes('\n');
}
