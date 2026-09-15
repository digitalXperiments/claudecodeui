import { HOOK_PROVIDER_ALL, type CloudcliHook } from '@/modules/hooks/hooks.types.js';

export function slugifyHookName(name: string): string {
  const slug = (name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'hook';
}

export function uniqueHookSlug(base: string, taken: Set<string>): string {
  const root = slugifyHookName(base);
  if (!taken.has(root)) return root;
  let n = 2;
  let candidate = `${root}-${n}`;
  while (taken.has(candidate)) {
    n += 1;
    candidate = `${root}-${n}`;
  }
  return candidate;
}

export function hookMatchesProvider(hook: Pick<CloudcliHook, 'provider'>, provider: string): boolean {
  const wanted = (provider ?? '').trim().toLowerCase();
  const filter = (hook.provider ?? HOOK_PROVIDER_ALL).trim().toLowerCase();
  if (!filter || filter === HOOK_PROVIDER_ALL) return true;
  return filter === wanted;
}

/**
 * Expand a hook body like custom commands: `$ARGUMENTS` is replaced with the
 * remainder after `/slug`. If there is no placeholder, the remainder is appended.
 */
export function expandHookInstruction(instruction: string, remainder: string): string {
  const body = instruction ?? '';
  const args = (remainder ?? '').trim();
  if (body.includes('$ARGUMENTS')) {
    return body.replace(/\$ARGUMENTS/g, args);
  }
  if (!args) return body;
  return `${body.trimEnd()}\n\n${args}`;
}
