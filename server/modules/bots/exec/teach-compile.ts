/**
 * Compile a recorded browser walkthrough (teach mode) into a parameterized SKILL.md draft.
 *
 * What is kept: page navigations (path only, query and fragment dropped), clicks (visible text and
 * selector), Enter presses, and field interactions. What is never kept: typed values. Every fill
 * and select becomes a named input (`{{email}}`) unless the operator marked that step or selector
 * safe, in which case the literal value is written into the step. Password-like fields are never
 * captured at all and always become secret inputs.
 */
import type { RecordedAction } from '@/modules/browser-use/index.js';

export interface TeachInput {
  name: string;
  label: string;
  /** True for password-like fields: the bot must ask the operator for the value at run time. */
  secret: boolean;
  /** The step number (1-based) where the input is used. */
  step: number;
}

export interface TeachStep {
  index: number;
  kind: RecordedAction['kind'];
  /** Human-readable instruction; never contains an unredacted typed value. */
  text: string;
  selector?: string;
  input?: string;
  /** True when a literal value was kept because the operator marked it safe. */
  safeLiteral?: boolean;
}

export interface CompileOptions {
  /** Step numbers (1-based, as listed in the response) whose values may be kept literally. */
  safeSteps?: number[];
  /** Selectors whose values may be kept literally. */
  safeFields?: string[];
  name?: string;
  description?: string;
  /** How to tell the workflow worked. Defaults to a placeholder the operator should edit. */
  successCheck?: string;
  startUrl?: string;
}

export interface CompiledTeach {
  name: string;
  description: string;
  content: string;
  steps: TeachStep[];
  inputs: TeachInput[];
  skipped: number;
}

export const MAX_TEACH_STEPS = 80;

const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

export function slugifyName(text: string, fallback = 'taught-workflow'): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || fallback;
}

/** `https://a.test/x?token=1#y` -> `https://a.test/x` (the query can carry credentials). */
export function redactUrl(raw: string): { url: string; hadQuery: boolean } {
  try {
    const parsed = new URL(raw);
    const hadQuery = Boolean(parsed.search || parsed.hash);
    return { url: `${parsed.origin}${parsed.pathname}`, hadQuery };
  } catch {
    return { url: '', hadQuery: false };
  }
}

function inputName(label: string, used: Set<string>): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32) || 'field';
  let name = /^[0-9]/.test(base) ? `field_${base}` : base;
  for (let i = 2; used.has(name); i += 1) name = `${base}_${i}`.slice(0, 40);
  used.add(name);
  return name;
}

function sameSafe(action: { selector: string }, index: number, options: CompileOptions): boolean {
  return Boolean(options.safeSteps?.includes(index) || options.safeFields?.includes(action.selector));
}

/** Steps and inputs only (also what the stop response returns for review). */
export function compileTeachSteps(
  actions: RecordedAction[],
  options: CompileOptions = {},
): { steps: TeachStep[]; inputs: TeachInput[]; skipped: number } {
  const steps: TeachStep[] = [];
  const inputs: TeachInput[] = [];
  const used = new Set<string>();
  let skipped = 0;

  for (const action of actions) {
    if (steps.length >= MAX_TEACH_STEPS) {
      skipped += 1;
      continue;
    }
    const index = steps.length + 1;
    switch (action.kind) {
      case 'navigate': {
        const { url, hadQuery } = redactUrl(action.url);
        if (!url) {
          skipped += 1;
          break;
        }
        const last = steps[steps.length - 1];
        if (action.implied && last) {
          // The page that loaded because of the previous step; note it instead of adding a step.
          last.text += ` (the page then loads ${url})`;
          break;
        }
        steps.push({ index, kind: 'navigate', text: `Open ${url}${hadQuery ? ' (query parameters omitted)' : ''}.` });
        break;
      }
      case 'click': {
        const target = action.text ? `"${clip(action.text, 60)}"` : `the ${action.tag ?? 'element'}`;
        steps.push({ index, kind: 'click', selector: action.selector, text: `Click ${target} (\`${action.selector}\`).` });
        break;
      }
      case 'press': {
        steps.push({ index, kind: 'press', selector: action.selector || undefined, text: `Press ${action.key}${action.selector ? ` in \`${action.selector}\`` : ''}.` });
        break;
      }
      case 'fill':
      case 'select': {
        const label = action.label || (action.kind === 'fill' ? action.name : '') || 'field';
        const secret = action.kind === 'fill' && action.sensitive;
        if (!secret && action.value !== null && sameSafe(action, index, options)) {
          steps.push({
            index,
            kind: action.kind,
            selector: action.selector,
            safeLiteral: true,
            text: action.kind === 'fill'
              ? `Type "${clip(action.value, 120)}" into ${label} (\`${action.selector}\`).`
              : `Choose "${clip(action.value, 120)}" in ${label} (\`${action.selector}\`).`,
          });
          break;
        }
        const name = inputName(label, used);
        inputs.push({ name, label: clip(label, 80), secret, step: index });
        steps.push({
          index,
          kind: action.kind,
          selector: action.selector,
          input: name,
          text: secret
            ? `Enter the ${label} secret into \`${action.selector}\` with browser_type_secret (ask the operator with browser_ask_human first; never type it with browser_type).`
            : action.kind === 'fill'
              ? `Type {{${name}}} into ${label} (\`${action.selector}\`).`
              : `Choose {{${name}}} in ${label} (\`${action.selector}\`).`,
        });
        break;
      }
      default:
        skipped += 1;
    }
  }
  return { steps, inputs, skipped };
}

function yamlLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function compileTeachSkill(actions: RecordedAction[], options: CompileOptions = {}): CompiledTeach {
  const { steps, inputs, skipped } = compileTeachSteps(actions, options);
  const firstNavigate = actions.find((action) => action.kind === 'navigate');
  const startUrl = redactUrl(options.startUrl ?? (firstNavigate?.kind === 'navigate' ? firstNavigate.url : '')).url;
  const host = (() => {
    try {
      return startUrl ? new URL(startUrl).hostname.replace(/^www\./, '') : '';
    } catch {
      return '';
    }
  })();
  const name = slugifyName(options.name?.trim() || (host ? `taught-${host}` : 'taught-workflow'));
  const description = clip(yamlLine(options.description?.trim() || `Repeat a browser workflow the operator demonstrated${host ? ` on ${host}` : ''}.`), 200);

  const lastNavigate = [...actions].reverse().find((action) => action.kind === 'navigate');
  const finalUrl = lastNavigate?.kind === 'navigate' ? redactUrl(lastNavigate.url).url : '';
  const success = options.successCheck?.trim()
    || (finalUrl
      ? `The browser ends on ${finalUrl} and shows no error message. (Edit this line to name something only a successful run shows.)`
      : 'The last step completes and the page shows no error message. (Edit this line to name something only a successful run shows.)');

  const lines: string[] = [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    `# ${clip(yamlLine(options.description?.trim() || `Taught workflow${host ? ` on ${host}` : ''}`), 80)}`,
    '',
    'Drafted from a demonstration in teach mode. Review every step, then enable the skill.',
    '',
    '## Inputs',
    ...(inputs.length > 0
      ? inputs.map((input) => `- \`${input.name}\`${input.secret ? ' (secret)' : ''}: ${input.label}${input.secret ? '. Ask the operator; never store or echo it.' : ''}`)
      : ['- None.']),
    '',
    '## Steps',
    ...(startUrl ? [`Start: ${startUrl}`, ''] : []),
    ...steps.map((step) => `${step.index}. ${step.text}`),
    ...(skipped > 0 ? ['', `(${skipped} further recorded action${skipped === 1 ? '' : 's'} were not included.)`] : []),
    '',
    '## Success check',
    success,
    '',
    '## Notes',
    '- Selectors were captured from the page during the demonstration and may need updating if the site changes.',
    '- Typed values were not recorded; each field above is an input unless the operator marked it safe.',
    '',
  ];
  return { name, description, content: lines.join('\n'), steps, inputs, skipped };
}
