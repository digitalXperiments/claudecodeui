import { botCommitmentsDb } from '@/modules/bots/kernel/bot-commitments.repository.js';
import { botEpisodesDb } from '@/modules/bots/kernel/bot-episodes.repository.js';
import { botGoalsDb } from '@/modules/bots/kernel/bot-goals.repository.js';

export {
  applyRoute,
  deriveTrigger,
  extendEpisodeDeadline,
  kernel,
  MAX_EPISODE_EXTENSION_MS,
  onEpisodeFinished,
  runBotNow,
  setKernelOptions,
  syncBotScheduleTrigger,
  trackedEpisodeRunIds,
} from '@/modules/bots/kernel/kernel.service.js';
export type {
  EpisodeListener,
  EpisodeResult,
  KernelOptions,
  WakeOptions,
  WakeStatus,
} from '@/modules/bots/kernel/kernel.service.js';
export { setKernelNotifier } from '@/modules/bots/kernel/kernel-notifier.js';
export type { KernelNotification, KernelNotifier } from '@/modules/bots/kernel/kernel-notifier.js';
export { botKernelRouter } from '@/modules/bots/kernel/kernel.routes.js';
export { parseKernelEnvelope, parseTriageVerdict } from '@/modules/bots/kernel/envelope.js';
export type { KernelEnvelope } from '@/modules/bots/kernel/envelope.js';
export {
  buildKernelPrompt,
  buildKernelPromptAsync,
  buildTriagePrompt,
  registerPerceiveSection,
  renderEvent,
} from '@/modules/bots/kernel/perceive.js';
export type { PerceiveSectionContext, PerceiveSectionFn } from '@/modules/bots/kernel/perceive.js';
export { applyGoalProgress, createCommitmentChecked, isProvenanceTainted } from '@/modules/bots/kernel/kernel-actions.js';
export { registerKernelGatewayTools } from '@/modules/bots/kernel/kernel-tools.js';
export { installKernel } from '@/modules/bots/kernel/install.js';

/** Service-contract names from IMPLEMENTATION.md (`goals.*`, `commitments.*`, `episodes.search`). */
export const goals = botGoalsDb;
export const commitments = botCommitmentsDb;
export const episodes = botEpisodesDb;
