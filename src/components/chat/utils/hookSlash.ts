export type HookCatalogItem = {
  id: string;
  name: string;
  slug?: string;
  enabled: boolean;
  instruction: string;
  provider: string;
};

export type HookSlashCommand = {
  name: string;
  description: string;
  namespace: 'hooks';
  type: 'hook';
  metadata: {
    type: 'hook';
    instruction: string;
    hookId: string;
    provider: string;
  };
};

export function expandHookInstruction(instruction: string, remainder: string): string {
  const body = instruction ?? '';
  const args = (remainder ?? '').trim();
  if (body.includes('$ARGUMENTS')) {
    return body.replace(/\$ARGUMENTS/g, args);
  }
  if (!args) return body;
  return `${body.trimEnd()}\n\n${args}`;
}

export function hookMatchesProvider(provider: string, currentProvider: string): boolean {
  const wanted = (currentProvider ?? '').trim().toLowerCase();
  const filter = (provider ?? 'all').trim().toLowerCase();
  if (!filter || filter === 'all') return true;
  return filter === wanted;
}

export function mapEnabledHooksToSlashCommands(
  hooks: readonly HookCatalogItem[],
  currentProvider: string,
): HookSlashCommand[] {
  const commands: HookSlashCommand[] = [];
  for (const hook of hooks) {
    if (!hook.enabled) continue;
    if (!hookMatchesProvider(hook.provider, currentProvider)) continue;
    const slug = (hook.slug ?? '').trim();
    if (!slug) continue;
    commands.push({
      name: `/${slug}`,
      description: hook.name,
      namespace: 'hooks',
      type: 'hook',
      metadata: {
        type: 'hook',
        instruction: hook.instruction,
        hookId: hook.id,
        provider: hook.provider,
      },
    });
  }
  return commands;
}
