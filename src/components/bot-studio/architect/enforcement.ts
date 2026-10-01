/** Plain-language wording for the enforcement level shown before a bot exists. */

import type { BotGateLevel } from '../types/botRuntime';

export type EnforcementCopy = { level: BotGateLevel; headline: string; detail: string };

export function enforcementCopy(provider: string, level: BotGateLevel): EnforcementCopy {
  if (level === 'off') {
    return {
      level,
      headline: 'Off',
      detail: `There is no action gate on this bot (Bypass), so nothing it does on ${provider} is checked. Only ${provider}'s own permission setting applies.`,
    };
  }
  if (level === 'enforced') {
    return {
      level,
      headline: 'Enforced',
      detail: `On ${provider}, every tool call and built-in action this bot makes goes through the action gate, so your rules and the safety floor always apply.`,
    };
  }
  return {
    level,
    headline: 'Advisory',
    detail: `On ${provider}, the action gate governs the tool calls it can see, but ${provider} can also use its own built-in tools or connectors that the gate cannot see. Rules are a strong guide here, not a guarantee. Pick a provider marked Enforced if you need a hard limit.`,
  };
}
