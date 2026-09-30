import { SAFETY_FLOOR, type Risk } from '@/modules/bots/gate/gate.types.js';

export { SAFETY_FLOOR };

export interface ClassifyToolInput {
  server: string;
  tool: string;
  annotations?: Record<string, unknown>;
  description?: string;
}

type VerbRisk = 'send' | 'publish' | 'delete' | 'purchase' | 'prod_change' | 'read';

const VERBS: Record<string, VerbRisk> = {};
function register(risk: VerbRisk, words: string[]): void {
  for (const word of words) VERBS[word] = risk;
}
register('send', ['send', 'reply', 'forward']);
register('publish', ['publish', 'tweet', 'post', 'share']);
register('delete', ['delete', 'remove', 'trash', 'purge', 'drop', 'destroy', 'erase']);
register('purchase', ['purchase', 'pay', 'checkout', 'order', 'buy', 'charge']);
register('prod_change', ['deploy', 'merge', 'push', 'release', 'transition', 'rollback', 'prod']);
register(
  'read',
  [
    'get', 'list', 'search', 'read', 'fetch', 'query', 'describe', 'find', 'view',
    'retrieve', 'lookup', 'show', 'count', 'snapshot', 'screenshot',
  ],
);

const CREDENTIAL_WORDS = new Set(['password', 'token', 'secret', 'credential', 'oauth', 'apikey']);

function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter(Boolean);
}

/** Try the token as-is, then without a plural/3rd-person `s` / `es` ("sends", "pushes"). */
function variants(token: string): string[] {
  const out = [token];
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) out.push(token.slice(0, -1));
  if (token.length > 4 && token.endsWith('es')) out.push(token.slice(0, -2));
  return out;
}

function singular(token: string): string {
  return variants(token).find((candidate) => candidate in VERBS || candidate === 'draft' || CREDENTIAL_WORDS.has(candidate)) ?? token;
}

interface Hit {
  risk: VerbRisk;
  index: number;
}

/** Classify a token stream; returns `null` when nothing in it says anything about risk. */
function classifyTokens(rawTokens: string[]): Risk | null {
  const tokens = rawTokens.map(singular);
  let verb: Hit | null = null;
  let hasDraft = false;
  let hasCredential = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === 'draft') hasDraft = true;
    if (CREDENTIAL_WORDS.has(token)) hasCredential = true;
    if (token === 'api' && tokens[i + 1] === 'key') hasCredential = true;
    if (verb) continue;
    // "post message" / "post_message" is a send, not a public publish.
    if (token === 'post' && tokens[i + 1] === 'message') {
      verb = { risk: 'send', index: i };
    } else if (token in VERBS) {
      verb = { risk: VERBS[token], index: i };
    }
  }

  if (verb && verb.risk === 'read') return hasCredential ? 'credential' : 'read';
  if (verb) {
    if (hasDraft) {
      // "send_draft" sends; "send_message_draft" / "create_draft_order" only stage a draft.
      if (verb.risk === 'send' || verb.risk === 'publish') {
        if (tokens[verb.index + 1] !== 'draft') return 'draft';
      } else if (verb.risk === 'purchase' || verb.risk === 'prod_change') {
        return 'draft';
      }
    }
    return verb.risk;
  }
  if (hasCredential) return 'credential';
  if (hasDraft) return 'draft';
  return null;
}

/**
 * Infer the risk of an MCP tool call. MCP annotations win (`destructiveHint` →
 * delete, `readOnlyHint` → read), then the tool name, then the first words of
 * the description. Anything unrecognised is `unknown` (the gate asks).
 */
export function classifyToolRisk(input: ClassifyToolInput): Risk {
  const { annotations } = input;
  if (annotations?.destructiveHint === true) return 'delete';
  if (annotations?.readOnlyHint === true) return 'read';

  const fromName = classifyTokens(tokenize(input.tool));
  if (fromName) return fromName;

  const description = input.description?.trim();
  if (description) {
    const firstSentence = description.split(/(?<=[.!?])\s/)[0] ?? description;
    const words = tokenize(firstSentence).slice(0, 8);
    const fromDescription = classifyTokens(words);
    if (fromDescription) return fromDescription;
  }
  return 'unknown';
}
