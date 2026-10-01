/**
 * Read-only analysis for the built-in tool gate.
 *
 * Reads are never a question for a gated bot at any autonomy level: a file tool that only looks
 * (Read, Glob, Grep, LS, view_file, read_file, list_dir ...) or a shell command that is provably a
 * pipeline of read-only programs (cat, head, tail, ls, find, grep, rg, sed -n, wc, stat, file ...)
 * runs anywhere on the machine EXCEPT the protected credential list, which the hard denylist
 * enforces before this module is consulted. This module answers two questions about a call:
 *
 *  - `analyzeReadOnlyCall`: is it read-only, and which paths does it name?  (null = cannot prove it)
 *  - `skillsReadReason` helpers: does it only touch the provider skill folders (`~/.claude/skills`,
 *    `~/.codex/skills`, ...), which are the one place under a protected directory a bot may read?
 *
 * The shell model is deliberately tiny and strict: no expansions, substitutions, redirects, heredocs,
 * globs in content reads, option that can write or run code (`sed -i`, `find -exec`, `rg --pre`,
 * `sort -o`, `file -f`, `grep -f`, `wc --files0-from` ...). Anything it does not recognise is "not
 * read-only", which falls back to the strict guard's escalation (a human decides).
 */
import os from 'node:os';
import path from 'node:path';
import { realpathSync } from 'node:fs';

import { EXTENDED_PATH_KEYS, EXTENDED_PATH_LIST_KEYS } from '@/modules/permissions/index.js';
import { protectedSegmentsReason } from '@/modules/bots/gate/strict-guard.js';

export interface ReadOperand {
  text: string;
  /** Holds an unquoted glob character. */
  glob: boolean;
  /** `content`: the bytes are read; `names`: only names / metadata are read (ls, find, stat, Glob). */
  kind: 'content' | 'names';
}

export interface ReadOnlyCall {
  operands: ReadOperand[];
  /** Operands whose whole subtree is walked (grep -r, rg, the Grep tool; find, ls -R, du, tree list names). */
  recursive: ReadOperand[];
}

// ---------------------------------------------------------------------------
// Shell tokenizer: strict subset

interface Token {
  text: string;
  glob: boolean;
}

/** Splits into pipeline / list segments; null when the text uses anything outside the strict subset. */
function tokenizeStrict(command: string): Token[][] | null {
  if (command.length > 2_000) return null;
  const segments: Token[][] = [];
  let tokens: Token[] = [];
  let current: Token | null = null;
  let pendingOperator = false;
  let index = 0;

  const endToken = (): void => {
    if (current) tokens.push(current);
    current = null;
  };
  const endSegment = (allowEmpty: boolean): boolean => {
    endToken();
    if (tokens.length === 0) return allowEmpty;
    segments.push(tokens);
    tokens = [];
    return true;
  };

  while (index < command.length) {
    const char = command[index];
    if (char === ' ' || char === '\t') {
      endToken();
      index += 1;
    } else if (char === "'") {
      const end = command.indexOf("'", index + 1);
      if (end < 0) return null;
      current ??= { text: '', glob: false };
      current.text += command.slice(index + 1, end);
      pendingOperator = false;
      index = end + 1;
    } else if (char === '"') {
      current ??= { text: '', glob: false };
      let cursor = index + 1;
      while (cursor < command.length && command[cursor] !== '"') {
        const inner = command[cursor];
        if (inner === '$' || inner === '`' || inner === '\\' || inner === '!') return null;
        current.text += inner;
        cursor += 1;
      }
      if (cursor >= command.length) return null;
      pendingOperator = false;
      index = cursor + 1;
    } else if (char === '|') {
      if (!endSegment(false)) return null;
      pendingOperator = true;
      index += command[index + 1] === '|' ? 2 : 1;
    } else if (char === '&') {
      if (command[index + 1] !== '&') return null;
      if (!endSegment(false)) return null;
      pendingOperator = true;
      index += 2;
    } else if (char === ';') {
      if (!endSegment(true)) return null;
      pendingOperator = false;
      index += 1;
    } else if ('`$(){}<>\\!\n\r'.includes(char)) {
      return null;
    } else {
      if (char === '~') {
        // Only a leading `~` or `~/` is the home directory; `~user` and a mid-word `~` are not handled.
        const atStart = !current || current.text === '';
        const next = command[index + 1];
        if (atStart && next !== undefined && next !== '/' && next !== ' ' && next !== '\t' && next !== '|' && next !== ';' && next !== '&') return null;
      }
      if (char === '#' && (!current || current.text === '')) return null;
      current ??= { text: '', glob: false };
      if (char === '*' || char === '?' || char === '[') current.glob = true;
      current.text += char;
      pendingOperator = false;
      index += 1;
    }
  }
  endToken();
  if (tokens.length > 0) segments.push(tokens);
  // A trailing `;` is fine; a dangling `|` / `&&` is not.
  else if (pendingOperator) return null;
  return segments;
}

// ---------------------------------------------------------------------------
// Per-command rules

interface FlagSpec {
  short: string;
  /** Short flags that take a value (the rest of the cluster or the next word). */
  valued?: string;
  /** Valued short flags whose value must be a number. */
  numeric?: string;
  /** Long flags (name without `=value`); `=value` or no value both accepted, a separate value is not. */
  long?: readonly string[];
  /** Long flags that must carry `=value` (a separate value word would be misread as an operand). */
  longValued?: readonly string[];
  /** `-5` style count. */
  digits?: boolean;
}

interface ParsedArgs {
  flags: Set<string>;
  values: Map<string, string>;
  operands: Token[];
}

function parseArgs(args: Token[], spec: FlagSpec): ParsedArgs | null {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const operands: Token[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const text = arg.text;
    if (text === '--') return null;
    if (text.startsWith('--')) {
      const name = text.split('=')[0];
      if (!spec.long?.includes(name)) return null;
      if (spec.longValued?.includes(name) && !text.includes('=')) return null;
      flags.add(name);
      continue;
    }
    if (text.startsWith('-') && text.length > 1) {
      if (spec.digits && /^-\d+$/.test(text)) {
        flags.add('digits');
        continue;
      }
      for (let at = 1; at < text.length; at += 1) {
        const flag = text[at];
        if (!spec.short.includes(flag) && !spec.valued?.includes(flag)) return null;
        flags.add(flag);
        if (spec.valued?.includes(flag)) {
          let value = text.slice(at + 1);
          if (!value) {
            index += 1;
            if (index >= args.length) return null;
            value = args[index].text;
          }
          if (spec.numeric?.includes(flag) && !/^[+-]?\d+$/.test(value)) return null;
          values.set(flag, value);
          break;
        }
      }
      continue;
    }
    operands.push(arg);
  }
  return { flags, values, operands };
}

const SED_SCRIPT = /^(?:(?:\d+|\$|\/[^/]+\/)(?:,(?:\d+|\$|\/[^/]+\/))?)?p$/;
const FIND_NO_ARG = new Set(['-print', '-print0', '-empty', '-not', '-a', '-o', '-and', '-or', '-true', '!']);
const FIND_VALUED = new Set(['-name', '-iname', '-path', '-ipath', '-type', '-maxdepth', '-mindepth', '-mtime', '-mmin', '-atime', '-newer', '-size', '-perm', '-user', '-group', '-regex']);

interface SegmentAnalysis {
  operands: ReadOperand[];
  recursive: ReadOperand[];
}

const operand = (token: Token, kind: ReadOperand['kind']): ReadOperand => ({ text: token.text, glob: token.glob, kind });

function analyzeSegment(tokens: Token[]): SegmentAnalysis | null {
  if (tokens.length === 0) return null;
  const headText = tokens[0].text;
  const head = /^\/(?:usr\/)?bin\/[a-z]+$/.test(headText) ? path.basename(headText) : headText;
  if (tokens[0].glob || /[/=]/.test(head)) return null;
  const args = tokens.slice(1);
  const content = (parsed: ParsedArgs): SegmentAnalysis => ({ operands: parsed.operands.map((token) => operand(token, 'content')), recursive: [] });

  switch (head) {
    case 'cat': {
      const parsed = parseArgs(args, { short: 'nbsvAeEtT' });
      return parsed ? content(parsed) : null;
    }
    case 'head':
    case 'tail': {
      const parsed = parseArgs(args, { short: 'qv', valued: 'nc', numeric: 'nc', digits: true });
      return parsed ? content(parsed) : null;
    }
    case 'wc': {
      const parsed = parseArgs(args, { short: 'lwcmL' });
      return parsed ? content(parsed) : null;
    }
    case 'nl':
    case 'cut': {
      const parsed = parseArgs(args, head === 'cut' ? { short: 's', valued: 'dfbc' } : { short: 'ba' });
      return parsed ? content(parsed) : null;
    }
    case 'file': {
      const parsed = parseArgs(args, { short: 'bikLNnsz' });
      return parsed ? content(parsed) : null;
    }
    case 'ls': {
      const parsed = parseArgs(args, { short: 'laAhR1tSrdFGpiCxn', long: ['--color', '--all', '--almost-all', '--human-readable'] });
      if (!parsed) return null;
      const listed = parsed.operands.map((token) => operand(token, 'names'));
      // `ls -R` walks every folder below its roots.
      return { operands: listed, recursive: parsed.flags.has('R') ? (listed.length > 0 ? listed : [operand({ text: '.', glob: false }, 'names')]) : [] };
    }
    case 'du':
    case 'tree': {
      const parsed = parseArgs(args, head === 'du' ? { short: 'hsckaxH', valued: 'd', numeric: 'd' } : { short: 'adfhCiFsDp', valued: 'L', numeric: 'L' });
      if (!parsed) return null;
      const listed = parsed.operands.map((token) => operand(token, 'names'));
      return { operands: listed, recursive: listed.length > 0 ? listed : [operand({ text: '.', glob: false }, 'names')] };
    }
    case 'stat': {
      const parsed = parseArgs(args, { short: 'Llnsxqr', valued: 'fc' });
      return parsed ? { operands: parsed.operands.map((token) => operand(token, 'names')), recursive: [] } : null;
    }
    case 'grep':
    case 'rg': {
      const parsed = parseArgs(
        args,
        head === 'grep'
          ? {
              short: 'rnilcHhwFEvsIoaqz',
              valued: 'ABCme',
              numeric: 'ABCm',
              long: ['--include', '--exclude', '--exclude-dir', '--color', '--max-count'],
              longValued: ['--include', '--exclude', '--exclude-dir', '--max-count'],
            }
          : {
              short: 'nilcHhwFvsSuUoq',
              valued: 'ABCmegt',
              numeric: 'ABCm',
              long: ['--hidden', '--no-ignore', '--files', '--glob', '--type', '--max-count', '--ignore-case', '--line-number', '--count', '--files-with-matches', '--no-messages', '--no-heading', '--color'],
              longValued: ['--glob', '--type', '--max-count'],
            },
      );
      if (!parsed) return null;
      let operands = parsed.operands;
      const patternGiven = parsed.values.has('e') || (head === 'rg' && parsed.flags.has('--files'));
      if (!patternGiven) {
        if (operands.length === 0) return null;
        operands = operands.slice(1);
      }
      const recursive = head === 'rg' || parsed.flags.has('r');
      const files = operands.map((token) => operand(token, 'content'));
      // No path: rg / grep -r search the working directory; plain grep reads stdin.
      const searched = files.length > 0 ? files : recursive ? [{ text: '.', glob: false, kind: 'content' as const }] : [];
      return { operands: files, recursive: recursive ? searched : [] };
    }
    case 'sed': {
      const parsed = parseArgs(args, { short: 'nEr' });
      if (!parsed || !parsed.flags.has('n') || parsed.operands.length === 0) return null;
      if (!SED_SCRIPT.test(parsed.operands[0].text)) return null;
      return { operands: parsed.operands.slice(1).map((token) => operand(token, 'content')), recursive: [] };
    }
    case 'find': {
      const starts: Token[] = [];
      let at = 0;
      while (at < args.length && !args[at].text.startsWith('-') && args[at].text !== '!') {
        starts.push(args[at]);
        at += 1;
      }
      for (; at < args.length; at += 1) {
        const text = args[at].text;
        if (FIND_NO_ARG.has(text)) continue;
        if (FIND_VALUED.has(text) && at + 1 < args.length) {
          at += 1;
          continue;
        }
        return null;
      }
      const roots = starts.length > 0 ? starts : [{ text: '.', glob: false }];
      const listed = roots.map((token) => operand(token, 'names'));
      // `find` walks every folder below its roots (names only, but the walk must not start at a folder holding credentials).
      return { operands: listed, recursive: listed };
    }
    case 'sort': {
      const parsed = parseArgs(args, { short: 'rnufbdVhM' });
      return parsed ? content(parsed) : null;
    }
    case 'uniq': {
      const parsed = parseArgs(args, { short: 'cdui' });
      return parsed && parsed.operands.length === 0 ? { operands: [], recursive: [] } : null;
    }
    case 'tr': {
      const parsed = parseArgs(args, { short: 'dsc' });
      return parsed ? { operands: [], recursive: [] } : null;
    }
    case 'echo':
    case 'pwd':
    case 'basename':
    case 'dirname':
    case 'true':
      return args.every((arg) => !arg.text.startsWith('-') || head === 'echo') ? { operands: [], recursive: [] } : null;
    default:
      return null;
  }
}

/** Strips one `zsh -lc "<payload>"` style wrapper (what several providers send for every shell call). */
function unwrapShell(command: string): string {
  const tokens = tokenizeStrict(command);
  if (!tokens || tokens.length !== 1) return command;
  const [head, ...rest] = tokens[0];
  if (!/^(?:\/(?:usr\/)?bin\/)?(?:sh|bash|zsh|dash)$/.test(head.text) || rest.length !== 2) return command;
  return /^-[a-z]*c$/i.test(rest[0].text) ? rest[1].text : command;
}

/** A pipeline / list of read-only programs, or null. */
export function analyzeReadOnlyShell(command: string): ReadOnlyCall | null {
  const segments = tokenizeStrict(unwrapShell(command.trim()));
  if (!segments || segments.length === 0) return null;
  const operands: ReadOperand[] = [];
  const recursive: ReadOperand[] = [];
  for (const segment of segments) {
    const analysis = analyzeSegment(segment);
    if (!analysis) return null;
    operands.push(...analysis.operands);
    recursive.push(...analysis.recursive);
  }
  return { operands, recursive };
}

// ---------------------------------------------------------------------------
// File tools

const norm = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');
const CONTENT_TOOLS = new Set(['read', 'readfile', 'viewfile', 'view', 'catfile', 'readmanyfiles']);
const NAMES_TOOLS = new Set(['glob', 'ls', 'listdir', 'listdirectory', 'list', 'filesearch', 'findfiles', 'globfiles', 'findbyname', 'listfiles']);
const SEARCH_TOOLS = new Set(['grep', 'grepsearch', 'search', 'codebasesearch', 'searchfiles']);
/** Built-in tools whose path defaults to the working directory when none is given. */
const CWD_DEFAULT_TOOLS = new Set(['glob', 'grep', 'ls']);
// The shared set (Antigravity `AbsolutePath` / `DirectoryPath` / `SearchPath` / `TargetDirectories` ...) plus this module's own.
const PATH_KEYS = [
  'file_path', 'filePath', 'abs_path', 'absPath', 'target_file', 'file', 'path', 'directory', 'dir', 'target_directory',
  ...EXTENDED_PATH_KEYS,
];
const PATH_LIST_KEYS = ['paths', 'files', 'file_paths', ...EXTENDED_PATH_LIST_KEYS];

function tooledPaths(record: Record<string, unknown>): string[] | null {
  const out: string[] = [];
  const add = (value: unknown): boolean => {
    if (value === undefined || value === null || value === '') return true;
    if (typeof value !== 'string') return false;
    out.push(value);
    return true;
  };
  for (const key of PATH_KEYS) if (!add(record[key])) return null;
  for (const key of PATH_LIST_KEYS) {
    const list = record[key];
    if (list === undefined || list === null) continue;
    if (typeof list === 'string') {
      if (!add(list)) return null;
      continue;
    }
    if (!Array.isArray(list)) return null;
    for (const entry of list) if (!add(entry)) return null;
  }
  return out;
}

const hasExpansion = (text: string): boolean => /[$`\0]/.test(text) || /^~[^/]/.test(text);

/** A path-taking built-in tool that only looks at things. Null for anything else. */
export function analyzeReadOnlyTool(toolName: string, input: unknown): ReadOnlyCall | null {
  const key = norm(toolName);
  const kind = CONTENT_TOOLS.has(key) ? 'content' : NAMES_TOOLS.has(key) ? 'names' : SEARCH_TOOLS.has(key) ? 'search' : null;
  if (!kind) return null;
  const record = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const paths = tooledPaths(record);
  if (!paths || paths.some(hasExpansion)) return null;
  const operandKind: ReadOperand['kind'] = kind === 'names' ? 'names' : 'content';
  const operands: ReadOperand[] = paths.map((text) => ({ text, glob: false, kind: operandKind }));
  // A Glob pattern that starts at an absolute / home path names a directory too.
  const patterns: string[] = [];
  if (kind === 'names' && typeof record.pattern === 'string') patterns.push(record.pattern);
  if (typeof record.glob === 'string') patterns.push(record.glob);
  for (const pattern of patterns) {
    if (hasExpansion(pattern) || pattern.split('/').includes('..')) return null;
    if (/^(?:~|\/)/.test(pattern)) {
      const wild = pattern.search(/[*?[{]/);
      const prefix = wild < 0 ? pattern : pattern.slice(0, wild);
      const directory = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/') + 1) : '';
      if (!directory) return null;
      operands.push({ text: directory, glob: false, kind: 'names' });
    }
  }
  if (kind === 'content' && operands.length === 0) return null;
  // A provider tool that names no folder (`codebase_search { Query }`) searches something we cannot see;
  // only the built-in Grep / Glob / LS are defined to start at the working directory.
  if (operands.length === 0 && !CWD_DEFAULT_TOOLS.has(key)) return null;
  if (kind === 'search') {
    const targets = operands.length > 0 ? operands : [{ text: '.', glob: false, kind: 'content' as const }];
    return { operands: targets, recursive: targets };
  }
  return { operands: operands.length > 0 ? operands : [{ text: '.', glob: false, kind: operandKind }], recursive: [] };
}

const READISH_TOKENS = new Set(['view', 'read', 'list', 'ls', 'find', 'grep', 'glob', 'search', 'cat', 'open', 'tree', 'locate', 'show', 'peek', 'scan']);
/** Read-looking tools that never touch the file system (network / bookkeeping), so a missing path is normal. */
const PATHLESS_READISH = /^(?:web|tool|todo|task|skill|mcp)/;

/**
 * Why a tool that LOOKS like it reads or lists files (`view_file`, `read_*`, `*_search`, `find_*`, `list_*`,
 * `grep*`, `glob*` ...) cannot be allowed: it names no path we can recognise, so what it reads is unknown.
 * Null when the call is a shell command, names a path, is a built-in that defaults to the working
 * directory, or is not a read-looking tool at all.
 */
export function opaqueReadToolReason(toolName: string, paths: string[], command: string | null): string | null {
  if (command || paths.length > 0) return null;
  const spaced = toolName.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  const key = norm(toolName);
  if (CWD_DEFAULT_TOOLS.has(key) || PATHLESS_READISH.test(key)) return null;
  const tokens = spaced.split(/[^a-z0-9]+/).filter(Boolean);
  if (!tokens.some((token) => READISH_TOKENS.has(token))) return null;
  return `${toolName} looks like a read / search tool but names no path, so what it reads cannot be shown`;
}

/** Read-only analysis of any built-in call: a read tool, or a shell command that is only reads. */
export function analyzeReadOnlyCall(toolName: string, input: unknown, command: string | null): ReadOnlyCall | null {
  if (command) return analyzeReadOnlyShell(command);
  return analyzeReadOnlyTool(toolName, input);
}

// ---------------------------------------------------------------------------
// Locations

function safeRealpath(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}

/** Resolves symlinks on the nearest existing ancestor and re-attaches the missing tail. */
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

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const homeForms = (): string[] => [...new Set([os.homedir(), safeRealpath(os.homedir())])];

/** Names under the home directory that are protected as a whole (a recursive search must not reach them). */
const PROTECTED_HOME_ENTRIES = [
  '.cloudcli', '.grok', '.codex', '.gemini', '.claude', '.claude.json', '.cursor', '.docker', '.ssh', '.aws', '.azure',
  '.kube', '.gnupg', '.netrc', '.git-credentials', '.config', '.zsh_history', '.bash_history',
  path.join('Library', 'Keychains'), path.join('Library', 'Application Support'),
];

/** True when searching inside `directory` could reach a protected credential location. */
export function directoryReachesProtected(directory: string): boolean {
  const canonical = canonicalize(path.resolve(directory));
  for (const home of homeForms()) {
    for (const entry of PROTECTED_HOME_ENTRIES) {
      if (isInside(path.join(home, entry), canonical)) return true;
    }
  }
  return false;
}

/** Absolute, symlink-resolved form of an operand (relative to `cwd`, `~` expanded). */
export function resolveOperand(text: string, cwd: string): string {
  const expanded = text === '~' || text.startsWith('~/') ? path.join(os.homedir(), text.slice(1)) : text;
  return canonicalize(path.resolve(cwd, expanded));
}

// ---------------------------------------------------------------------------
// Skill folders: the one readable place under a protected directory

/** Provider / agent skill folders under the home directory. */
export const SKILL_ROOT_DIRS = ['.agents', '.claude', '.codex', '.grok', '.cursor', '.cloudcli'] as const;
const DB_FILE = /\.(?:db|sqlite3?|db-wal|db-shm)$/i;

/**
 * The skill roots a bot may read, as real paths: `~/<dir>/skills` for each provider dir, and the
 * bot's own home skills. A root that is a symlink is followed, but only when its target is not
 * (inside) a protected location itself (`~/.agents/skills -> ~/.claude` is refused) and does not
 * contain the home directory (`skills -> ~`).
 */
export function skillRoots(botHome: string): string[] {
  const lexical: string[] = [];
  for (const home of homeForms()) for (const dir of SKILL_ROOT_DIRS) lexical.push(path.join(home, dir, 'skills'));
  lexical.push(path.join(path.resolve(botHome), 'skills'));
  const roots = new Set<string>();
  for (const root of lexical) {
    roots.add(root);
    const real = canonicalize(root);
    if (real === root) continue;
    const underHome = homeForms().some((home) => isInside(real, home));
    const containsHome = homeForms().some((home) => isInside(home, real));
    if (containsHome) continue;
    const relative = homeForms().map((home) => (isInside(real, home) ? path.relative(home, real) : null)).find((rel) => rel !== null);
    const protectedReason = underHome && relative ? protectedSegmentsReason(relative.split(path.sep)) : null;
    // `~/.agents/skills -> ~/.claude/skills` is fine (the target is itself a skill folder); a link to
    // anything else under a protected directory (`~/.cursor/skills -> ~/.claude`) is not.
    if (protectedReason && !lexical.includes(real)) continue;
    roots.add(real);
  }
  return [...roots];
}

/**
 * Whether `operand` (a file or folder) is inside a skill root after symlinks are resolved, with
 * nothing protected below the root. `..` is refused outright (symlink + `..` resolve differently in
 * the shell and in a file tool).
 */
export function isSkillsPath(operand: ReadOperand, cwd: string, roots: string[]): boolean {
  const text = operand.text.trim();
  if (!text || hasExpansion(text)) return false;
  if (text.split('/').includes('..')) return false;
  let target = text;
  if (operand.glob) {
    // Judge the folder the glob starts in; the wildcard part may only name things below it.
    const wild = text.search(/[*?[{]/);
    const prefix = wild < 0 ? text : text.slice(0, wild);
    target = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/') + 1) : '.';
    if (operand.kind === 'content') return false;
  }
  const absolute = resolveOperand(target, cwd);
  if (DB_FILE.test(absolute)) return false;
  for (const root of roots) {
    if (!isInside(absolute, root)) continue;
    const below = path.relative(root, absolute);
    const segments = below === '' ? [] : below.split(path.sep);
    if (protectedSegmentsReason(segments)) return false;
    if (operand.glob && protectedSegmentsReason(text.slice(target === '.' ? 0 : target.length).split('/'))) return false;
    return true;
  }
  return false;
}

/** True when every path the call names is inside a skill root (and it names at least one). */
export function isSkillsReadOnly(call: ReadOnlyCall, cwd: string, botHome: string): boolean {
  if (call.operands.length === 0) return false;
  const roots = skillRoots(botHome);
  return call.operands.every((entry) => isSkillsPath(entry, cwd, roots));
}

/**
 * Whether a read-only call may skip the strict guard's "outside the workspace" escalation: no
 * wildcard in a content read outside the working folder (it could match a credential file) and no
 * recursive search rooted anywhere that holds a protected location.
 */
export function outsideReadIsSafe(call: ReadOnlyCall, cwd: string): boolean {
  for (const entry of call.operands) {
    if (entry.glob && entry.kind === 'content' && (/^(?:~|\/)/.test(entry.text) || entry.text.split('/').includes('..'))) return false;
  }
  for (const entry of call.recursive) {
    if (entry.glob) return false;
    if (directoryReachesProtected(resolveOperand(entry.text, cwd))) return false;
  }
  return true;
}
