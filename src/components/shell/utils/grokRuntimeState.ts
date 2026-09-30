export type GrokRuntimeStateChangedDetail = {
  model?: string;
  effort?: string;
};

const ANSI_SEQUENCE_REGEX = /\u001B\[[0-?]*[ -/]*[@-~]/g;

/** Longer ids first so `grok-4.7-build-fast` wins over `grok-4.7`. */
const GROK_MODEL_IDS = [
  'grok-4.7-build-fast',
  'grok-4.7',
  'grok-4.6',
  'grok-4.5',
  'grok-4.3',
  'grok-build-0.1',
] as const;

const GROK_DISPLAY_NAMES: Array<{ pattern: RegExp; id: string }> = [
  { pattern: /grok\s*4\.7\s*fast\b/gi, id: 'grok-4.7-build-fast' },
  { pattern: /grok\s*4\.7\b/gi, id: 'grok-4.7' },
  { pattern: /grok\s*4\.6\b/gi, id: 'grok-4.6' },
  { pattern: /grok\s*4\.5\b/gi, id: 'grok-4.5' },
];

const MODEL_ID_REGEX = new RegExp(`\\b(?:${GROK_MODEL_IDS.map((id) => id.replace(/\./g, '\\.')).join('|')})\\b`, 'gi');
const MODEL_TOKEN = String.raw`(?:grok-4\.\d[\w.-]*|grok\s*4\.\d(?:\s*fast)?)`;
const EFFORT_WORD = String.raw`(extra\s*high|xhigh|high|medium|low)`;

function normalizeEffort(raw: string | undefined): string | undefined {
  const value = (raw || '').toLowerCase().replace(/\s+/g, '');
  if (value === 'extrahigh' || value === 'xhigh') return 'xhigh';
  if (value === 'high' || value === 'medium' || value === 'low') return value;
  return undefined;
}

/** Latest model mention wins, whether it is an id or the status-line display name. */
function parseModel(text: string): string | undefined {
  const hits: Array<{ end: number; id: string }> = [];
  for (const match of text.matchAll(MODEL_ID_REGEX)) {
    if (match.index == null) continue;
    hits.push({ end: match.index + match[0].length, id: match[0].toLowerCase() });
  }
  for (const entry of GROK_DISPLAY_NAMES) {
    for (const match of text.matchAll(entry.pattern)) {
      if (match.index == null) continue;
      hits.push({ end: match.index + match[0].length, id: entry.id });
    }
  }
  if (hits.length === 0) return undefined;
  hits.sort((left, right) => left.end - right.end);
  return hits[hits.length - 1]?.id;
}

function parseEffort(text: string): string | undefined {
  const labeled = [...text.matchAll(new RegExp(`(?:reasoning\\s+effort|effort)\\s*[:=]\\s*${EFFORT_WORD}\\b`, 'gi'))];
  // Status line is `Grok 4.7 (low)`, not `Grok 4.7 low`.
  const compact = [...text.matchAll(new RegExp(`${MODEL_TOKEN}\\s*(?:\\(\\s*)?${EFFORT_WORD}\\b`, 'gi'))];
  const labeledAt = labeled.length ? (labeled[labeled.length - 1].index ?? -1) : -1;
  const compactAt = compact.length ? (compact[compact.length - 1].index ?? -1) : -1;
  const raw = compactAt >= labeledAt
    ? compact[compact.length - 1]?.[1]
    : labeled[labeled.length - 1]?.[1];
  return normalizeEffort(raw);
}

/**
 * Resolve Grok model/effort mentions in a piece of text. Only used for the
 * arguments of explicit `/model` input (see parseGrokSlashCommand): terminal
 * output is NOT parsed — the server reads the TUI's summary.json instead,
 * because any reply that mentions a model would otherwise flip the chat.
 */
export function parseGrokRuntimeState(output: string): GrokRuntimeStateChangedDetail {
  const clean = output.replace(ANSI_SEQUENCE_REGEX, '');
  const detail: GrokRuntimeStateChangedDetail = {};

  const model = parseModel(clean);
  if (model) detail.model = model;

  const effort = parseEffort(clean);
  if (effort) detail.effort = effort;

  return detail;
}

/** Parse a completed TUI line the user typed, e.g. `/model grok-4.7-build-fast`. */
export function parseGrokSlashCommand(line: string): GrokRuntimeStateChangedDetail {
  const trimmed = line.trim();
  const modelCommand = trimmed.match(/^\/(?:model|m)\s+(.+)$/i);
  if (modelCommand) {
    const rest = modelCommand[1].trim();
    const fromOutput = parseGrokRuntimeState(rest);
    const effortArg = rest.split(/\s+/).pop()?.toLowerCase();
    const effort = effortArg && ['low', 'medium', 'high', 'xhigh'].includes(effortArg)
      ? effortArg
      : fromOutput.effort;
    const detail: GrokRuntimeStateChangedDetail = {};
    if (fromOutput.model) detail.model = fromOutput.model;
    if (effort) detail.effort = effort;
    return detail;
  }

  const effortCommand = trimmed.match(/^\/effort\s+(extra\s*high|xhigh|high|medium|low)\b/i);
  if (effortCommand) {
    const raw = effortCommand[1].toLowerCase().replace(/\s+/g, '');
    return { effort: raw === 'extrahigh' ? 'xhigh' : raw };
  }

  return {};
}
