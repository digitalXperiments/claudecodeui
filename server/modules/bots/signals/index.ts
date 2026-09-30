export { botSignals, clampCoalesceMs, DEFAULT_COALESCE_MS, MAX_COALESCE_MS } from '@/modules/bots/signals/signals.service.js';
export {
  botTriggers,
  ensureCronTriggerFromSection,
  fireScheduledTrigger,
  getScheduledTriggerCount,
  pollWatchTrigger,
  scanCommitments,
  startSignals,
  stopSignals,
  TRIGGER_KINDS,
  validateTriggerConfig,
} from '@/modules/bots/signals/triggers.service.js';
export {
  compileNaturalSchedule,
  isScheduleExcluded,
  type CompiledSchedule,
  type NaturalScheduleResult,
  type ScheduleExclusions,
} from '@/modules/bots/signals/nl-schedule.js';
export { handleAutomationEvent, startAutomationBridge, stopAutomationBridge } from '@/modules/bots/signals/automation-bridge.js';
export { botHooksPublicRouter, botTriggersRouter, MAX_HOOK_BODY_BYTES } from '@/modules/bots/signals/signals.routes.js';
export {
  getWatchAdapter,
  listWatchAdapterKinds,
  registerBuiltInWatchAdapters,
  registerWatchAdapter,
  type WatchAdapter,
  type WatchEventDraft,
  type WatchPollResult,
} from '@/modules/bots/signals/adapters/index.js';
