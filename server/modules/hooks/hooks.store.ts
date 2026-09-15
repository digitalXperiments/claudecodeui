import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { newHookId } from '@/shared/ids.js';
import { slugifyHookName, uniqueHookSlug } from '@/modules/hooks/hooks.compile.js';
import {
  HOOK_EVENTS,
  HOOK_PROVIDER_ALL,
  isHookEvent,
  type CloudcliHook,
  type CloudcliHookCreateInput,
  type CloudcliHookUpdateInput,
} from '@/modules/hooks/hooks.types.js';
import { AppError } from '@/shared/utils.js';

const STORE_VERSION = 1;

type HooksFile = {
  version: number;
  hooks: CloudcliHook[];
};

let overridePath: string | null = null;

/** Tests: point the JSON catalog at `tmp/cloudcli/` so we never touch `~/.cloudcli`. */
export function configureHooksStorePath(filePath: string | null): void {
  overridePath = filePath;
}

export function getHooksStorePath(): string {
  return overridePath ?? path.join(os.homedir(), '.cloudcli', 'hooks.json');
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const parseHook = (value: unknown): CloudcliHook | null => {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || !value.id.trim()) return null;
  if (typeof value.name !== 'string') return null;
  if (typeof value.instruction !== 'string') return null;
  if (typeof value.enabled !== 'boolean') return null;
  if (!isHookEvent(value.event)) return null;
  if (typeof value.provider !== 'string' || !value.provider.trim()) return null;
  if (typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') return null;
  const slug =
    typeof value.slug === 'string' && value.slug.trim()
      ? slugifyHookName(value.slug)
      : '';
  return {
    id: value.id,
    name: value.name,
    slug,
    enabled: value.enabled,
    event: value.event,
    instruction: value.instruction,
    provider: value.provider,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
};

const assignUniqueSlugs = (hooks: CloudcliHook[]): { hooks: CloudcliHook[]; changed: boolean } => {
  const taken = new Set<string>();
  let changed = false;
  const next = hooks.map((hook) => {
    const base = hook.slug || slugifyHookName(hook.name);
    const slug = uniqueHookSlug(base, taken);
    taken.add(slug);
    if (slug !== hook.slug) {
      changed = true;
      return { ...hook, slug };
    }
    return hook;
  });
  return { hooks: next, changed };
};

const readStore = (): CloudcliHook[] => {
  const filePath = getHooksStorePath();
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.hooks)) {
      return [];
    }
    const parsedHooks = parsed.hooks.map(parseHook).filter((hook): hook is CloudcliHook => hook !== null);
    const { hooks, changed } = assignUniqueSlugs(parsedHooks);
    if (changed) {
      writeStore(hooks);
    }
    return hooks;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return [];
    }
    throw error;
  }
};

const writeStore = (hooks: CloudcliHook[]): void => {
  const filePath = getHooksStorePath();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const payload: HooksFile = { version: STORE_VERSION, hooks };
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
};

const normalizeName = (name: string): string => name.trim();

const normalizeInstruction = (instruction: string): string => instruction;

const normalizeProvider = (provider: string | undefined): string => {
  const trimmed = (provider ?? HOOK_PROVIDER_ALL).trim();
  return trimmed || HOOK_PROVIDER_ALL;
};

export const hooksStore = {
  list(): CloudcliHook[] {
    return readStore();
  },

  get(id: string): CloudcliHook | null {
    return readStore().find((hook) => hook.id === id) ?? null;
  },

  create(input: CloudcliHookCreateInput): CloudcliHook {
    const name = normalizeName(input.name);
    if (!name) {
      throw new AppError('name is required', { code: 'HOOK_NAME_REQUIRED', statusCode: 400 });
    }
    const instruction = normalizeInstruction(input.instruction ?? '');
    if (!instruction.trim()) {
      throw new AppError('instruction is required', { code: 'HOOK_INSTRUCTION_REQUIRED', statusCode: 400 });
    }
    const event = input.event ?? HOOK_EVENTS[0];
    if (!isHookEvent(event)) {
      throw new AppError('event must be session_start', { code: 'HOOK_EVENT_INVALID', statusCode: 400 });
    }

    const now = new Date().toISOString();
    const hooks = readStore();
    const taken = new Set(hooks.map((item) => item.slug));
    const slug = uniqueHookSlug(input.slug || name, taken);
    const hook: CloudcliHook = {
      id: newHookId(),
      name,
      slug,
      enabled: input.enabled !== false,
      event,
      instruction,
      provider: normalizeProvider(input.provider),
      createdAt: now,
      updatedAt: now,
    };
    hooks.push(hook);
    writeStore(hooks);
    return hook;
  },

  update(id: string, patch: CloudcliHookUpdateInput): CloudcliHook {
    const hooks = readStore();
    const index = hooks.findIndex((hook) => hook.id === id);
    if (index < 0) {
      throw new AppError('Hook not found', { code: 'HOOK_NOT_FOUND', statusCode: 404 });
    }
    const current = hooks[index];
    const nextName = patch.name !== undefined ? normalizeName(patch.name) : current.name;
    if (!nextName) {
      throw new AppError('name is required', { code: 'HOOK_NAME_REQUIRED', statusCode: 400 });
    }
    const nextInstruction =
      patch.instruction !== undefined ? normalizeInstruction(patch.instruction) : current.instruction;
    if (!nextInstruction.trim()) {
      throw new AppError('instruction is required', { code: 'HOOK_INSTRUCTION_REQUIRED', statusCode: 400 });
    }
    if (patch.event !== undefined && !isHookEvent(patch.event)) {
      throw new AppError('event must be session_start', { code: 'HOOK_EVENT_INVALID', statusCode: 400 });
    }

    const taken = new Set(hooks.filter((item) => item.id !== id).map((item) => item.slug));
    const nextSlug =
      patch.slug !== undefined
        ? uniqueHookSlug(patch.slug || nextName, taken)
        : patch.name !== undefined && nextName !== current.name
          ? uniqueHookSlug(nextName, taken)
          : current.slug || uniqueHookSlug(nextName, taken);

    const updated: CloudcliHook = {
      ...current,
      name: nextName,
      slug: nextSlug,
      instruction: nextInstruction,
      enabled: patch.enabled ?? current.enabled,
      event: patch.event ?? current.event,
      provider: patch.provider !== undefined ? normalizeProvider(patch.provider) : current.provider,
      updatedAt: new Date().toISOString(),
    };
    hooks[index] = updated;
    writeStore(hooks);
    return updated;
  },

  remove(id: string): void {
    const hooks = readStore();
    const next = hooks.filter((hook) => hook.id !== id);
    if (next.length === hooks.length) {
      throw new AppError('Hook not found', { code: 'HOOK_NOT_FOUND', statusCode: 404 });
    }
    writeStore(next);
  },
};
