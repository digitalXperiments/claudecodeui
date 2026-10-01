/**
 * Strict (gateway-bound bot run) path and shell analysis for the built-in tool gate.
 *
 * The permission classifier answers "is this a read?"; it does not answer "is this MY login?".
 * A gateway-bound run holds a copy or symlink of the operator's real Codex / Grok / Antigravity
 * login inside a per-run home, and a shell that can say `cat "$GROK_HOME/auth.json"` reads it. This
 * module is the second opinion the gate asks before the classifier is allowed to auto-approve:
 *
 *  - HARD DENY (never reaches a human): any path segment or word that names a credential store
 *    (`.cloudcli`, `.grok`, `.codex`, `.gemini`, `.claude`, `.ssh`, `.aws`, `Library/Keychains`,
 *    `auth.json`, `id_rsa*`, `*.pem`, ...) in any spelling (bare, relative, quoted, after `cd`,
 *    glob/quote/escape-obfuscated), and any reference to `HOME`, `GROK_HOME`, `CODEX_HOME`,
 *    `GEMINI_HOME`, `CLOUDCLI_*`, `XDG_*`. Paths that resolve inside the bot's own home are exempt.
 *  - ESCALATE (a human decides): anything the analysis cannot prove stays inside the workspace, the
 *    bot home or OS temp: absolute / tilde paths elsewhere, `..` that leaves, `cd` elsewhere, other
 *    `$VAR`s, command substitution, ANSI-C quoting, globs whose static prefix is outside. When
 *    unsure the answer is "escalate", never "approve".
 *
 * Only the built-in gate (gateway-bound bot runs) calls this; the shared classifier and interactive
 * provider sessions are untouched.
 *
 * The shell analysis is a best-effort token-level model, not a shell. It is deliberately
 * conservative: false positives cost an operator click, false negatives cost a login.
 */
import os from 'node:os';
import path from 'node:path';
import { lstatSync, realpathSync, statSync } from 'node:fs';

import { stripHeredocBodies } from '@/modules/permissions/index.js';

export interface StrictScope {
  workspaceRoot: string;
  botHome: string;
  /** Directory a shell command runs in; defaults to the workspace root. */
  cwd?: string | null;
}

export interface StrictFinding {
  /** Hard denial reason, or null. */
  deny: string | null;
  /** Reason a human must decide, or null. Only meaningful when `deny` is null. */
  escalate: string | null;
}

// ---------------------------------------------------------------------------
// What is protected

/** Names that are credential / secret stores wherever they appear as a path segment. */
const PROTECTED_NAMES: readonly string[] = [
  '.cloudcli', '.grok', '.codex', '.gemini', '.claude', '.claude.json', '.cursor', '.docker',
  '.ssh', '.aws', '.azure', '.kube', '.gnupg', '.netrc', '.git-credentials',
  '.zsh_history', '.bash_history',
  // Directories under ~/.cloudcli (and the Antigravity profile) that hold copies or links of logins.
  'grok-strict-runs', 'codex-bot-homes', 'grok-runtime', 'antigravity-acp',
];
const PROTECTED_NAME_SET = new Set(PROTECTED_NAMES.map((name) => name.toLowerCase()));

const CREDENTIAL_FILES: readonly string[] = [
  'auth.json', 'acp_token.json', 'acp_business_token.json', 'oauth_creds.json', 'credentials.json', 'mcp_credentials.json',
];
const CREDENTIAL_FILE_SET = new Set(CREDENTIAL_FILES.map((name) => name.toLowerCase()));

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A protected name in free text: bounded so `my.codex` and `.cloudcli-x` do not match. */
const TEXT_PROTECTED_NAME = new RegExp(
  `(?<![\\w.-])(?:${[...PROTECTED_NAMES, ...CREDENTIAL_FILES].map(escapeRegExp).join('|')})(?![\\w-])`,
  'i',
);
const TEXT_KEY_FILE = /(?<![\w-])id_(?:rsa|ed25519)[\w.-]*|\.pem(?![\w-])/i;
const TEXT_LIBRARY = /(?<![\w-])Library[\\/](?:Keychains|Application)/i;

/** `$HOME`, `${HOME}`, `${!HOME}` ... regardless of quoting (a single-quoted payload is run later). */
const PROTECTED_VAR = /\$\{?!?\s*(?:HOME|GROK_HOME|CODEX_HOME|GEMINI_HOME|CLOUDCLI_[A-Za-z0-9_]*|XDG_[A-Za-z0-9_]*)(?![A-Za-z0-9_])/;
const isProtectedVarName = (name: string): boolean => (
  name === 'HOME' || name === 'GROK_HOME' || name === 'CODEX_HOME' || name === 'GEMINI_HOME'
  || name.startsWith('CLOUDCLI_') || name.startsWith('XDG_')
);

function segmentReason(segment: string): string | null {
  const lowered = segment.toLowerCase();
  if (PROTECTED_NAME_SET.has(lowered)) return `${segment} is a protected credential location`;
  if (CREDENTIAL_FILE_SET.has(lowered)) return `${segment} holds credentials`;
  if (lowered.endsWith('.pem')) return `${segment} is a private key / certificate`;
  if (lowered.startsWith('id_rsa') || lowered.startsWith('id_ed25519')) return `${segment} is an SSH key`;
  return null;
}

/** Reason when any path segment (or the Library/Keychains pair) is protected. */
export function protectedSegmentsReason(segments: string[]): string | null {
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment) continue;
    const reason = segmentReason(segment);
    if (reason) return reason;
    if (segment.toLowerCase() === 'library') {
      const next = (segments[index + 1] ?? '').toLowerCase();
      if (next === 'keychains' || next === 'application support' || next === 'application') {
        return `Library/${segments[index + 1]} is a protected credential location`;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Locations

function canonicalize(target: string): string {
  let prefix = target;
  let suffix = '';
  for (;;) {
    try {
      const real = realpathSync(prefix);
      return suffix ? path.join(real, suffix) : real;
    } catch {
      const parent = path.dirname(prefix);
      if (parent === prefix) return target;
      suffix = suffix ? path.join(path.basename(prefix), suffix) : path.basename(prefix);
      prefix = parent;
    }
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

type Location = 'botHome' | 'workspace' | 'temp' | 'outside';

const unique = (values: string[]): string[] => [...new Set(values)];
const forms = (target: string): string[] => unique([path.resolve(target), canonicalize(path.resolve(target))]);

class Roots {
  readonly workspace: string[];
  readonly botHome: string[];
  readonly temp: string[];
  readonly home: string;

  constructor(scope: StrictScope) {
    this.workspace = forms(scope.workspaceRoot || '/');
    this.botHome = forms(scope.botHome || '/nonexistent-bot-home');
    this.temp = unique([os.tmpdir(), '/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp'].flatMap(forms));
    this.home = os.homedir();
  }

  /** Where a path really is (symlinks resolved). */
  locate(target: string): Location {
    const canonical = canonicalize(target);
    if (this.botHome.some((root) => isInside(canonical, root))) return 'botHome';
    if (this.workspace.some((root) => isInside(canonical, root))) return 'workspace';
    if (this.temp.some((root) => isInside(canonical, root))) return 'temp';
    return 'outside';
  }

  /** Segments of `target` that count for the name check: relative to the workspace when inside it. */
  nameSegments(target: string): string[] {
    const canonical = canonicalize(target);
    for (const root of this.workspace) {
      if (isInside(canonical, root)) return path.relative(root, canonical).split(path.sep);
    }
    return canonical.split(path.sep);
  }
}

/**
 * Resolves `text` the way a shell does: `..` after a symlink goes to the symlink target's parent,
 * not the lexical parent. `base` must already be absolute.
 */
function resolveWalk(base: string, text: string): string {
  let current = text.startsWith('/') ? '/' : base;
  for (const part of text.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      current = path.dirname(current);
      continue;
    }
    current = path.join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) current = realpathSync(current);
    } catch {
      // Does not exist (yet): keep the lexical path.
    }
  }
  return current;
}

function expandTilde(text: string, home: string): string {
  if (text === '~') return home;
  if (text.startsWith('~/')) return path.join(home, text.slice(2));
  return text;
}

const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const SYSTEM_BIN_DIRS = ['/bin/', '/usr/bin/', '/usr/local/bin/', '/opt/homebrew/bin/', '/usr/sbin/', '/sbin/'];
const DEVICE_FILES = new Set(['/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr']);

// ---------------------------------------------------------------------------
// Analysis state

interface Word {
  /** Decoded text (quotes and escapes removed); expansions contribute nothing. */
  text: string;
  /** Contains `$var`, `$(...)`, backticks, ANSI-C quoting: its value is unknown. */
  unresolved: boolean;
  /** Index in `text` of the first unquoted glob/brace character, or -1. */
  globAt: number;
}

interface State {
  scope: StrictScope;
  roots: Roots;
  cwd: string;
  /** A `cd` target did not exist, so the real cwd may still be the previous one. */
  uncertainCwd: boolean;
  deny: string | null;
  escalate: string | null;
}

const flagDeny = (state: State, reason: string): void => {
  state.deny ??= reason;
};
const flagEscalate = (state: State, reason: string): void => {
  state.escalate ??= reason;
};

const MAX_DEPTH = 5;
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const SEGMENT_PREFIX_WORDS = new Set(['!', 'do', 'then', 'else', 'elif', 'if', 'while', 'until', 'time', 'command', 'builtin', 'exec', 'nohup', 'nice', '{', '}']);
const INERT_SUBSTITUTION = /^(?:pwd|date(?:\s+\+?[\w%:.\-/ ]*)?)$/;
const INERT_HEREDOC_CAT = /^cat\s+<<-?\s*'([A-Za-z_]\w*)'[ \t]*\n[\s\S]*\n[ \t]*\1[ \t]*$/;

/** Index of the `)` that closes the `(` at `open`, skipping quotes and heredoc bodies; -1 when unbalanced. */
function matchParen(text: string, open: number): number {
  let depth = 0;
  const pending: Array<{ delimiter: string; stripTabs: boolean }> = [];
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\') {
      index += 1;
    } else if (char === "'") {
      const end = text.indexOf("'", index + 1);
      if (end < 0) return -1;
      index = end;
    } else if (char === '"') {
      for (index += 1; index < text.length && text[index] !== '"'; index += 1) {
        if (text[index] === '\\') index += 1;
      }
    } else if (char === '<' && text[index + 1] === '<' && text[index + 2] !== '<') {
      const match = /^<<(-?)[ \t]*(?:'([^']+)'|"([^"]+)"|\\?([^\s;|&()<>]+))/.exec(text.slice(index));
      if (match) {
        pending.push({ delimiter: match[2] ?? match[3] ?? match[4], stripTabs: match[1] === '-' });
        index += match[0].length - 1;
      } else {
        index += 1;
      }
    } else if (char === '\n' && pending.length > 0) {
      let cursor = index + 1;
      for (const heredoc of pending.splice(0)) {
        while (cursor < text.length) {
          const lineEnd = text.indexOf('\n', cursor);
          const end = lineEnd < 0 ? text.length : lineEnd;
          const line = text.slice(cursor, end);
          cursor = lineEnd < 0 ? text.length : lineEnd + 1;
          if ((heredoc.stripTabs ? line.replace(/^\t+/, '') : line) === heredoc.delimiter) break;
        }
      }
      index = cursor - 1;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function handleVarName(state: State, name: string): void {
  if (isProtectedVarName(name)) flagDeny(state, `reading $${name} is off-limits`);
  else flagEscalate(state, `uses the shell variable $${name}, which cannot be resolved ahead of time`);
}

function handleVarBraces(state: State, inner: string): void {
  if (inner.startsWith('!')) flagEscalate(state, 'uses indirect variable expansion');
  const match = /^[!#]?([A-Za-z_][A-Za-z0-9_]*)/.exec(inner);
  if (match) handleVarName(state, match[1]);
}

type Range = Array<[number, number]>;

/**
 * Analyses the text of a `$(...)` / backtick substitution. Returns the heredoc-body ranges removed
 * from it (relative to `inner`) so the caller can keep its own view in step with the classifier's.
 */
function handleSubstitution(state: State, inner: string, depth: number): Range {
  const trimmed = inner.trim();
  const inert = INERT_SUBSTITUTION.test(trimmed) || INERT_HEREDOC_CAT.test(trimmed);
  const savedEscalate = state.escalate;
  const savedCwd = state.cwd;
  if (!inert) flagEscalate(state, 'uses command substitution, which cannot be resolved ahead of time');
  const parsed = parseCommand(inner, state, depth + 1);
  state.cwd = savedCwd;
  // A harmless substitution (date, pwd, `cat <<'EOF'` data) must not make the whole command ask,
  // but anything a human-visible rule found inside it still stands for denies.
  if (inert) state.escalate = savedEscalate;
  return parsed.removed;
}

/** Variable references and substitutions inside an unquoted heredoc body (data, but expanded). */
function scanExpansionsOnly(body: string, state: State, depth: number): void {
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '\\') {
      index += 1;
    } else if (char === '$' && body[index + 1] === '(') {
      const close = matchParen(body, index + 1);
      if (close < 0) {
        flagEscalate(state, 'has an unterminated command substitution');
        return;
      }
      handleSubstitution(state, body.slice(index + 2, close), depth);
      index = close;
    } else if (char === '`') {
      const close = body.indexOf('`', index + 1);
      if (close < 0) {
        flagEscalate(state, 'has an unterminated command substitution');
        return;
      }
      handleSubstitution(state, body.slice(index + 1, close), depth);
      index = close;
    } else if (char === '$' && body[index + 1] === '{') {
      const close = body.indexOf('}', index + 2);
      handleVarBraces(state, body.slice(index + 2, close < 0 ? undefined : close));
      if (close >= 0) index = close;
    } else if (char === '$') {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(body.slice(index + 1));
      if (match) {
        handleVarName(state, match[0]);
        index += match[0].length;
      }
    }
  }
}

interface ParseResult {
  /** The input with every heredoc body and delimiter line removed. */
  kept: string;
  /** The removed ranges, relative to the parsed text. */
  removed: Range;
  heredocs: number;
}

/**
 * One pass over a command string: splits it into words, follows `cd`, recurses into substitutions
 * and `sh -c` payloads, and records deny / escalate findings on `state`.
 */
function parseCommand(text: string, state: State, depth: number): ParseResult {
  if (depth > MAX_DEPTH) {
    flagEscalate(state, 'nests shells or substitutions too deeply to check');
    return { kept: text, removed: [], heredocs: 0 };
  }
  const length = text.length;
  const removed: Range = [];
  const pendingHeredocs: Array<{ delimiter: string; quoted: boolean; stripTabs: boolean }> = [];
  const cwdStack: string[] = [];
  let heredocs = 0;
  let segment: Word[] = [];
  let word: Word | null = null;
  let index = 0;

  const startWord = (): Word => {
    word ??= { text: '', unresolved: false, globAt: -1 };
    return word;
  };
  const endWord = (): void => {
    if (word) segment.push(word);
    word = null;
  };
  const endSegment = (): void => {
    endWord();
    if (segment.length > 0) processSegment(segment, state, depth);
    segment = [];
  };

  const readDouble = (from: number): number => {
    const target = startWord();
    let cursor = from + 1;
    while (cursor < length && text[cursor] !== '"') {
      const char = text[cursor];
      if (char === '\\') {
        const next = text[cursor + 1];
        if (next && '$`"\\\n'.includes(next)) {
          if (next !== '\n') target.text += next;
          cursor += 2;
        } else {
          target.text += char;
          cursor += 1;
        }
      } else if (char === '$') {
        cursor = readDollar(cursor, true);
      } else if (char === '`') {
        cursor = readBacktick(cursor);
      } else {
        target.text += char;
        cursor += 1;
      }
    }
    if (cursor >= length) flagEscalate(state, 'has an unterminated quote');
    return cursor + 1;
  };

  const readBacktick = (from: number): number => {
    const target = startWord();
    target.unresolved = true;
    let cursor = from + 1;
    while (cursor < length && text[cursor] !== '`') cursor += text[cursor] === '\\' ? 2 : 1;
    if (cursor >= length) {
      flagEscalate(state, 'has an unterminated command substitution');
      return length;
    }
    for (const [a, b] of handleSubstitution(state, text.slice(from + 1, cursor), depth)) removed.push([a + from + 1, b + from + 1]);
    return cursor + 1;
  };

  const readDollar = (from: number, inDouble: boolean): number => {
    const target = startWord();
    const next = text[from + 1];
    if (next === '(') {
      target.unresolved = true;
      const close = matchParen(text, from + 1);
      if (close < 0) {
        flagEscalate(state, 'has an unterminated command substitution');
        return length;
      }
      for (const [a, b] of handleSubstitution(state, text.slice(from + 2, close), depth)) removed.push([a + from + 2, b + from + 2]);
      return close + 1;
    }
    if (next === '{') {
      target.unresolved = true;
      const close = text.indexOf('}', from + 2);
      if (close < 0) {
        flagEscalate(state, 'has an unterminated variable expansion');
        return length;
      }
      handleVarBraces(state, text.slice(from + 2, close));
      return close + 1;
    }
    if (next === "'" && !inDouble) {
      target.unresolved = true;
      flagEscalate(state, 'uses ANSI-C quoting ($\'...\'), which hides what the command names');
      let cursor = from + 2;
      while (cursor < length && text[cursor] !== "'") cursor += text[cursor] === '\\' ? 2 : 1;
      return cursor + 1;
    }
    if (next === '"' && !inDouble) return readDouble(from + 1);
    const named = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(from + 1));
    if (named) {
      target.unresolved = true;
      handleVarName(state, named[0]);
      return from + 1 + named[0].length;
    }
    if (next && /[0-9?#$!@*-]/.test(next)) {
      target.unresolved = true;
      return from + 2;
    }
    target.text += '$';
    return from + 1;
  };

  const readHeredocOperator = (from: number): number => {
    let cursor = from + 2;
    let stripTabs = false;
    if (text[cursor] === '-') {
      stripTabs = true;
      cursor += 1;
    }
    while (text[cursor] === ' ' || text[cursor] === '\t') cursor += 1;
    let quoted = false;
    let delimiter = '';
    const quote = text[cursor];
    if (quote === "'" || quote === '"') {
      quoted = true;
      const end = text.indexOf(quote, cursor + 1);
      delimiter = text.slice(cursor + 1, end < 0 ? length : end);
      cursor = end < 0 ? length : end + 1;
    } else {
      if (text[cursor] === '\\') {
        quoted = true;
        cursor += 1;
      }
      const match = /^[^\s;|&()<>]+/.exec(text.slice(cursor));
      delimiter = match ? match[0] : '';
      cursor += delimiter.length;
    }
    if (delimiter) {
      pendingHeredocs.push({ delimiter, quoted, stripTabs });
      heredocs += 1;
    }
    return cursor;
  };

  /** Called with `cursor` just after a newline: swallows the bodies of the heredocs opened on that line. */
  const consumeHeredocBodies = (from: number): number => {
    let cursor = from;
    for (const heredoc of pendingHeredocs.splice(0)) {
      const start = cursor;
      let body = '';
      let closed = false;
      while (cursor < length && !closed) {
        const lineEnd = text.indexOf('\n', cursor);
        const end = lineEnd < 0 ? length : lineEnd;
        const line = text.slice(cursor, end);
        const compared = heredoc.stripTabs ? line.replace(/^\t+/, '') : line;
        cursor = lineEnd < 0 ? length : lineEnd + 1;
        if (compared === heredoc.delimiter) closed = true;
        else body += `${line}\n`;
      }
      removed.push([start, cursor]);
      if (!heredoc.quoted) scanExpansionsOnly(body, state, depth);
    }
    return cursor;
  };

  while (index < length) {
    const char = text[index];
    if (char === ' ' || char === '\t' || char === '\r') {
      endWord();
      index += 1;
    } else if (char === '\n') {
      endSegment();
      index = consumeHeredocBodies(index + 1);
    } else if (char === ';' || char === '|' || char === '&') {
      endSegment();
      index += 1;
    } else if (char === '(') {
      endSegment();
      cwdStack.push(state.cwd);
      index += 1;
    } else if (char === ')') {
      endSegment();
      state.cwd = cwdStack.pop() ?? state.cwd;
      index += 1;
    } else if (char === '<' || char === '>') {
      endWord();
      if (text.startsWith('<<<', index)) {
        index += 3;
      } else if (text.startsWith('<<', index)) {
        index = readHeredocOperator(index);
      } else if (text[index + 1] === '(') {
        const close = matchParen(text, index + 1);
        flagEscalate(state, 'uses process substitution, which cannot be resolved ahead of time');
        if (close < 0) {
          index = length;
        } else {
          const savedCwd = state.cwd;
          parseCommand(text.slice(index + 2, close), state, depth + 1);
          state.cwd = savedCwd;
          index = close + 1;
        }
      } else {
        index += 1;
        if (text[index] === char || text[index] === '&' || text[index] === '|') index += 1;
      }
    } else if (char === "'") {
      const target = startWord();
      const end = text.indexOf("'", index + 1);
      if (end < 0) {
        flagEscalate(state, 'has an unterminated quote');
        target.text += text.slice(index + 1);
        index = length;
      } else {
        target.text += text.slice(index + 1, end);
        index = end + 1;
      }
    } else if (char === '"') {
      index = readDouble(index);
    } else if (char === '\\') {
      if (text[index + 1] === '\n') {
        index += 2;
      } else {
        const target = startWord();
        if (index + 1 < length) target.text += text[index + 1];
        index += 2;
      }
    } else if (char === '$') {
      index = readDollar(index, false);
    } else if (char === '`') {
      index = readBacktick(index);
    } else if (char === '*' || char === '?' || char === '[') {
      const target = startWord();
      if (target.globAt < 0) target.globAt = target.text.length;
      target.text += char;
      index += 1;
    } else if (char === '{') {
      const target = startWord();
      const close = text.indexOf('}', index + 1);
      const inner = close < 0 ? '' : text.slice(index + 1, close);
      if (close >= 0 && (inner.includes(',') || inner.includes('..')) && target.globAt < 0) target.globAt = target.text.length;
      target.text += char;
      index += 1;
    } else {
      startWord().text += char;
      index += 1;
    }
  }
  endSegment();

  const merged = [...removed].sort((a, b) => a[0] - b[0]).reduce<Range>((acc, range) => {
    const last = acc[acc.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else acc.push([range[0], range[1]]);
    return acc;
  }, []);
  let kept = '';
  let from = 0;
  for (const [start, end] of merged) {
    kept += text.slice(from, start);
    from = end;
  }
  kept += text.slice(from);
  return { kept, removed: merged, heredocs };
}

// ---------------------------------------------------------------------------
// Word / segment checks

const isAssignment = (word: Word): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word.text);

/** Path-ish strings inside one word: the word itself, a flag's `=value`, `-Cpath`, `NAME=value`. */
function candidatesOf(text: string): string[] {
  if (text.startsWith('-')) {
    const assigned = /^-{1,2}[A-Za-z0-9][\w-]*=(.*)$/.exec(text);
    if (assigned) return assigned[1].split(':');
    const attached = /^-[A-Za-z]([/~.].*)$/.exec(text);
    return attached ? [attached[1]] : [];
  }
  const assignment = /^[A-Za-z_][A-Za-z0-9_]*=(.*)$/.exec(text);
  if (assignment) return assignment[1].split(':');
  return [text];
}

function checkWord(word: Word, isHead: boolean, state: State): void {
  let text = word.text;
  if (!text) return;
  if (/^file:\/\//i.test(text)) {
    try {
      text = decodeURIComponent(text.replace(/^file:\/\/[^/]*/i, ''));
    } catch {
      flagEscalate(state, 'names a file: URL that cannot be decoded');
      return;
    }
  } else if (URL_SCHEME.test(text)) {
    return;
  }
  for (const candidate of candidatesOf(text)) {
    if (!candidate) continue;
    const pathLike = candidate.includes('/') || candidate.startsWith('~') || candidate.startsWith('.') || word.globAt >= 0;
    if (word.unresolved) {
      // The value is unknown: only the literal parts can be judged, and a path-shaped one is unverifiable.
      const reason = protectedSegmentsReason(candidate.split('/'));
      if (reason) flagDeny(state, reason);
      if (pathLike) flagEscalate(state, `names a path built from an expansion: ${text}`);
      continue;
    }
    if (/^~[^/]/.test(candidate)) {
      flagEscalate(state, `names another user's home: ${candidate}`);
      continue;
    }
    const expanded = expandTilde(candidate, state.roots.home);
    if (word.globAt >= 0) {
      checkGlobbed(expanded, state, word);
      continue;
    }
    if (!pathLike) {
      const reason = protectedSegmentsReason([candidate]);
      if (reason) flagDeny(state, reason);
      continue;
    }
    if (state.uncertainCwd && candidate.split('/').includes('..')) {
      flagEscalate(state, 'uses ".." after a cd whose target could not be verified');
    }
    const absolute = resolveWalk(state.cwd, expanded);
    const where = state.roots.locate(absolute);
    if (where === 'botHome') continue;
    const reason = protectedSegmentsReason(state.roots.nameSegments(absolute));
    if (reason) flagDeny(state, reason);
    if (where !== 'outside') continue;
    if (DEVICE_FILES.has(absolute)) continue;
    if (isHead && SYSTEM_BIN_DIRS.some((dir) => absolute.startsWith(dir))) continue;
    flagEscalate(state, `references a path outside the workspace and bot home: ${candidate}`);
  }
}

/** A word with an unquoted glob/brace: judge the static prefix, and every literal piece for names. */
function checkGlobbed(expanded: string, state: State, word: Word): void {
  const literalReason = protectedSegmentsReason(expanded.split('/'));
  const globAt = expanded.search(/[*?[{]/);
  const prefix = globAt < 0 ? expanded : expanded.slice(0, globAt);
  const directory = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/') + 1) : '';
  const rest = expanded.slice(directory.length);
  const absolute = resolveWalk(state.cwd, directory || '.');
  const where = state.roots.locate(absolute);
  if (where === 'botHome') return;
  if (literalReason) flagDeny(state, literalReason);
  const reason = protectedSegmentsReason(state.roots.nameSegments(absolute));
  if (reason) flagDeny(state, reason);
  if (rest.split('/').includes('..')) flagEscalate(state, `uses ".." after a glob: ${word.text}`);
  if (where === 'outside') flagEscalate(state, `globs a path outside the workspace and bot home: ${word.text}`);
}

function changeDirectory(args: Word[], state: State): void {
  const target = args.find((candidate) => !candidate.text.startsWith('-') || candidate.text === '-');
  if (!target) {
    flagEscalate(state, 'cd with no target goes to the home directory');
    state.cwd = state.roots.home;
    return;
  }
  if (target.unresolved || target.globAt >= 0 || target.text === '-' || target.text === '') {
    flagEscalate(state, `cd to a directory that cannot be resolved ahead of time: ${target.text || '(empty)'}`);
    state.uncertainCwd = true;
    return;
  }
  const absolute = resolveWalk(state.cwd, expandTilde(target.text, state.roots.home));
  const where = state.roots.locate(absolute);
  if (where === 'outside') flagEscalate(state, `cd to a directory outside the workspace and bot home: ${target.text}`);
  let isDirectory = false;
  try {
    isDirectory = statSync(absolute).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) state.uncertainCwd = true;
  state.cwd = absolute;
}

function processSegment(words: Word[], state: State, depth: number): void {
  let headIndex = 0;
  while (headIndex < words.length && (isAssignment(words[headIndex]) || SEGMENT_PREFIX_WORDS.has(words[headIndex].text))) {
    headIndex += 1;
  }
  words.forEach((word, position) => checkWord(word, position === headIndex, state));
  const headWord = words[headIndex];
  if (!headWord) return;
  const head = path.basename(headWord.text).toLowerCase();
  const args = words.slice(headIndex + 1);
  if (head === 'cd' || head === 'pushd' || head === 'popd') {
    if (head === 'popd') {
      flagEscalate(state, 'popd returns to a directory that cannot be tracked');
      state.uncertainCwd = true;
    } else {
      changeDirectory(args, state);
    }
  } else if (SHELLS.has(head)) {
    const flag = args.findIndex((candidate) => /^-[a-z]*c$/i.test(candidate.text));
    const payload = flag >= 0 ? args[flag + 1] : undefined;
    if (payload) {
      if (payload.unresolved) flagEscalate(state, 'runs a shell payload built from an expansion');
      const savedCwd = state.cwd;
      parseCommand(payload.text, state, depth + 1);
      state.cwd = savedCwd;
    }
  } else if (head === 'eval') {
    const savedCwd = state.cwd;
    parseCommand(args.map((candidate) => candidate.text).join(' '), state, depth + 1);
    state.cwd = savedCwd;
  }
}

// ---------------------------------------------------------------------------
// Raw text scan

/** Removes words that start at a bot-home path and really resolve inside it. */
function exciseBotHome(text: string, state: State): string {
  const homes = unique([state.roots.home, canonicalize(state.roots.home)]);
  const tilde = state.roots.botHome.flatMap((form) => homes.filter((home) => isInside(form, home)).map((home) => `~${form.slice(home.length)}`));
  let result = text;
  for (const form of unique([...state.roots.botHome, ...tilde])) {
    const pattern = new RegExp(`(?<![\\w./~$-])${escapeRegExp(form)}(?=$|[/\\s'"\`;|&()<>])[^\\s'"\`;|&()<>]*`, 'g');
    result = result.replace(pattern, (match) => {
      const absolute = resolveWalk('/', expandTilde(match, state.roots.home));
      return state.roots.locate(absolute) === 'botHome' ? ' ' : match;
    });
  }
  return result;
}

function rawTextScan(kept: string, state: State): void {
  const variable = PROTECTED_VAR.exec(kept);
  if (variable) flagDeny(state, `reading ${variable[0].trim()} is off-limits`);
  const text = exciseBotHome(kept, state);
  const named = TEXT_PROTECTED_NAME.exec(text);
  if (named) flagDeny(state, `${named[0]} is a protected credential location`);
  const key = TEXT_KEY_FILE.exec(text);
  if (key) flagDeny(state, `${key[0]} is a key / certificate file`);
  const library = TEXT_LIBRARY.exec(text);
  if (library) flagDeny(state, `${library[0]} is a protected credential location`);
}

function nonEmptyLines(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean);
}

function newState(scope: StrictScope): State {
  const roots = new Roots(scope);
  const workspaceRoot = roots.workspace[roots.workspace.length - 1];
  const requested = typeof scope.cwd === 'string' && scope.cwd.trim() ? scope.cwd.trim() : '';
  const cwd = requested ? resolveWalk(workspaceRoot, expandTilde(requested, roots.home)) : workspaceRoot;
  return { scope, roots, cwd, uncertainCwd: false, deny: null, escalate: null };
}

/** Findings for a shell command run by a gateway-bound bot. */
export function assessShellCommand(command: string, scope: StrictScope): StrictFinding {
  const state = newState(scope);
  try {
    if (state.roots.locate(state.cwd) === 'outside') {
      flagEscalate(state, `runs in a directory outside the workspace and bot home: ${state.cwd}`);
    }
    const { kept } = parseCommand(command, state, 0);
    rawTextScan(kept, state);
    // The permission classifier drops "heredoc bodies" with a naive line scan; a `<<EOF` that is
    // really inside quotes would let it skip real commands. Only a faithful parse may rely on it.
    const classifierView = nonEmptyLines(stripHeredocBodies(command));
    const ourView = nonEmptyLines(kept);
    if (classifierView.length !== ourView.length || classifierView.some((line, index) => line !== ourView[index])) {
      flagEscalate(state, 'has a heredoc marker the permission classifier would misread');
    }
  } catch {
    flagEscalate(state, 'could not be analysed');
  }
  return { deny: state.deny, escalate: state.escalate };
}

// ---------------------------------------------------------------------------
// File tools (Read / Glob / Grep / Write / Edit / view_file ...)

/** A glob pattern (Glob `pattern`, Grep `glob`) relative to `base`. */
function assessGlob(pattern: string, base: string, state: State): void {
  if (PROTECTED_VAR.test(pattern)) flagDeny(state, 'reading environment variables is off-limits');
  if (/[$`]/.test(pattern)) {
    flagEscalate(state, `pattern contains an expansion: ${pattern}`);
    return;
  }
  const expanded = expandTilde(pattern, state.roots.home);
  const globAt = expanded.search(/[*?[{]/);
  const prefix = globAt < 0 ? expanded : expanded.slice(0, globAt);
  const directory = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/') + 1) : '';
  const rest = expanded.slice(directory.length);
  const absolute = resolveWalk(base, directory || '.');
  const where = state.roots.locate(absolute);
  if (where === 'botHome') return;
  const reason = protectedSegmentsReason(state.roots.nameSegments(absolute)) ?? protectedSegmentsReason(expanded.split('/'));
  if (reason) flagDeny(state, reason);
  if (rest.split('/').includes('..')) flagEscalate(state, `pattern uses ".." after a wildcard: ${pattern}`);
  if (where === 'outside') flagEscalate(state, `pattern reaches outside the workspace and bot home: ${pattern}`);
}

function assessPathValue(raw: string, state: State, label: string): void {
  let value = raw.trim();
  if (!value) return;
  if (/^file:\/\//i.test(value)) {
    try {
      value = decodeURIComponent(value.replace(/^file:\/\/[^/]*/i, ''));
    } catch {
      flagEscalate(state, `${label} is a file: URL that cannot be decoded`);
      return;
    }
  }
  if (PROTECTED_VAR.test(value)) flagDeny(state, 'reading environment variables is off-limits');
  if (/[$`]/.test(value)) {
    const literal = protectedSegmentsReason(value.split('/'));
    if (literal) flagDeny(state, literal);
    flagEscalate(state, `${label} contains an expansion: ${raw}`);
    return;
  }
  if (/^~[^/]/.test(value)) {
    flagEscalate(state, `${label} names another user's home: ${raw}`);
    return;
  }
  const absolute = resolveWalk(state.cwd, expandTilde(value, state.roots.home));
  const where = state.roots.locate(absolute);
  if (where === 'botHome') return;
  const reason = protectedSegmentsReason(state.roots.nameSegments(absolute));
  if (reason) flagDeny(state, reason);
  if (where === 'outside' && !DEVICE_FILES.has(absolute)) {
    flagEscalate(state, `${label} reaches outside the workspace and bot home: ${raw}`);
  }
}

/** Findings for a path-taking built-in tool call (no shell). */
export function assessFileTool(
  toolName: string,
  record: Record<string, unknown>,
  paths: string[],
  scope: StrictScope,
): StrictFinding {
  const state = newState({ ...scope, cwd: null });
  try {
    const seen = new Set<string>();
    const add = (value: unknown): void => {
      if (typeof value === 'string' && value.trim()) seen.add(value);
    };
    for (const entry of paths) add(entry);
    for (const key of ['directory', 'dir', 'cwd', 'path']) add(record[key]);
    for (const entry of seen) assessPathValue(entry, state, `${toolName} target`);
    const globs: string[] = [];
    if (typeof record.glob === 'string') globs.push(record.glob);
    if (typeof record.pattern === 'string' && /glob|^ls$|list|find|search_file|file_search/i.test(toolName)) globs.push(record.pattern);
    const base = typeof record.path === 'string' && record.path.trim()
      ? resolveWalk(state.cwd, expandTilde(record.path.trim(), state.roots.home))
      : state.cwd;
    for (const pattern of globs) assessGlob(pattern, base, state);
    const url = typeof record.url === 'string' ? record.url : '';
    if (/^file:/i.test(url)) assessPathValue(url, state, `${toolName} url`);
  } catch {
    flagEscalate(state, `${toolName} target could not be analysed`);
  }
  return { deny: state.deny || null, escalate: state.escalate };
}
