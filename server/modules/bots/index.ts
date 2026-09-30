export type * from '@/modules/bots/bots.types.js';
export {
  normalizeBotRuntimeConfig,
  patchBotRuntimeConfig,
  readBotRuntimeConfig,
} from '@/modules/bots/bots-runtime-config.js';
export type { BotPhaseRoute, BotRuntimeConfig } from '@/modules/bots/bots-runtime-config.js';
export { resolveBotHome, resolveBotsRoot } from '@/modules/bots/bots-home.js';
export { deleteBotRuntimeData } from '@/modules/bots/bots-runtime-data.js';

export { botEventsDb } from '@/modules/bots/signals/bot-events.repository.js';
export { botTriggersDb } from '@/modules/bots/signals/bot-triggers.repository.js';
export { botLeasesDb } from '@/modules/bots/kernel/bot-leases.repository.js';
export { botGoalsDb } from '@/modules/bots/kernel/bot-goals.repository.js';
export { botCommitmentsDb } from '@/modules/bots/kernel/bot-commitments.repository.js';
export { botEpisodesDb } from '@/modules/bots/kernel/bot-episodes.repository.js';
export { botRulesDb } from '@/modules/bots/gate/bot-rules.repository.js';
export { botGateDecisionsDb } from '@/modules/bots/gate/bot-gate-decisions.repository.js';
export { botBudgetsDb } from '@/modules/bots/gate/bot-budgets.repository.js';
export { botProposalsDb } from '@/modules/bots/learning/bot-proposals.repository.js';
export { botSkillsDb } from '@/modules/bots/learning/bot-skills.repository.js';
export { botOperatorProfileDb } from '@/modules/bots/learning/bot-operator-profile.repository.js';
export { botChannelsDb } from '@/modules/bots/channels/bot-channels.repository.js';
export { botThreadDb } from '@/modules/bots/channels/bot-thread.repository.js';
export { botOutboundLogDb } from '@/modules/bots/channels/bot-outbound-log.repository.js';
export { botTeamsDb } from '@/modules/bots/collab/bot-teams.repository.js';
export { botSpacesDb } from '@/modules/bots/collab/bot-spaces.repository.js';

export * from '@/modules/bots/gate/index.js';
export * from '@/modules/bots/gateway/index.js';
export * from '@/modules/bots/signals/index.js';
export * from '@/modules/bots/kernel/index.js';
export * from '@/modules/bots/channels/index.js';
export * from '@/modules/bots/learning/index.js';
export * from '@/modules/bots/exec/index.js';
export * from '@/modules/bots/collab/index.js';
export {
  bootBotsRuntime,
  isBotsRuntimeForcedOff,
  isBotsRuntimeRunning,
  registerBotsRuntimeHook,
  setBotsRuntimeWakeHandler,
  startBotsRuntime,
  stopBotsRuntime,
} from '@/modules/bots/bots-runtime.boot.js';
