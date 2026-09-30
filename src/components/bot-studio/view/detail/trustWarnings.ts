import { pipelineStages, type Bot } from '../../types';

type TrustSource = Pick<Bot, 'permission_mode' | 'resolve_prompt' | 'auto_approve' | 'work_profile' | 'produce_tools' | 'resolve_tools' | 'tool_policy' | 'provider' | 'scope'>;

/** Configuration warnings shown in Settings and summarized on Overview. */
export function trustWarnings(bot: TrustSource): string[] {
  const stages = pipelineStages(bot);
  const servers = [...new Set([...bot.produce_tools, ...bot.resolve_tools])];
  const recordOnlyAuto = stages.resolve === 'none' && stages.work === 'none' && bot.auto_approve;
  return [
    bot.permission_mode === 'bypassPermissions' ? 'Provider permission mode bypasses ordinary permission prompts.' : null,
    stages.resolve === 'auto' && stages.work === 'auto' ? 'Items run end-to-end without review.' : stages.resolve === 'auto' ? 'New items are resolved automatically without review.' : null,
    recordOnlyAuto ? 'New items are recorded as done without review.' : null,
    servers.some((server) => Object.keys(bot.tool_policy?.[server] ?? {}).length === 0) ? 'Some attached servers have no explicit per-tool decisions.' : null,
    bot.provider !== 'claude' && Object.values(bot.tool_policy ?? {}).some((policy) => Object.values(policy).some((decision) => decision !== 'allow')) ? 'This provider may treat per-tool policy as advisory; verify its runtime enforcement before unattended use.' : null,
    bot.scope === 'global' ? 'This bot runs in global scope rather than a selected project.' : null,
  ].filter((entry): entry is string => Boolean(entry));
}
