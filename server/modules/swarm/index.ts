export { default, default as swarmRoutes } from '@/modules/swarm/swarm.routes.js';
export { swarmDb } from '@/modules/swarm/swarm.repository.js';
export { recoverActiveSwarms, swarmService, setSwarmTestExecutor, matchRosterSeat } from '@/modules/swarm/swarm.service.js';
export { SWARM_PROVIDERS } from '@/modules/swarm/swarm-agent.service.js';
export {
  configureSwarmRuntimes,
  configureSwarmAbortFns,
  getSwarmSpawnFn,
  isSwarmProvider,
  parseMemberFindings,
  parseOrchestratorPlan,
  parseSynthesis,
  collectProjectGitContext,
  abortSwarmAgentSession,
} from '@/modules/swarm/swarm-agent.service.js';
export {
  swarmPermissionBroker,
  classifyPermissionRequest,
  classifyCommand,
  extractPermissionRequestDetails,
  isReadOnlySeatKind,
  configureSwarmPermissionResolver,
  configureSwarmPermissionAdjudicator,
  type SwarmPermissionContext,
  type SwarmPermissionOutcome,
  type PermissionClassification,
  type PermissionDecision,
  type PermissionRequestDetails,
} from '@/modules/swarm/swarm-permission-broker.service.js';
export {
  buildSwarmCostLedger,
  candidateValueScore,
  formatCostStats,
  MIN_LEDGER_SAMPLES,
  type ProfileCostStats,
  type SwarmCostLedger,
} from '@/modules/swarm/swarm-cost-ledger.service.js';
export {
  runSwarmValidationGate,
  swarmReportDir,
  configureSwarmValidationCommandRunner,
  configureSwarmValidationBrowser,
  configureSwarmValidationAppBooter,
  type SwarmValidationGateResult,
  type SwarmValidationCheck,
  type SwarmValidationCommandRunner,
  type SwarmValidationBrowser,
  type SwarmValidationBrowserFactory,
  type SwarmValidationAppBooter,
} from '@/modules/swarm/swarm-validation.service.js';
export {
  effectiveScore,
  capabilityScoreForTask,
  canonicalizeCatalogModels,
  exportSnapshot,
  getStaffingPrefs,
  listModelCapabilities,
  matchBenchmarkFamily,
  outcomeCorrection,
  rankCandidatesForTask,
  refreshModelRegistry,
  registryIsStale,
  setModelEnabled,
  setStaffingPrefs,
  upsertModelCapability,
  BENCHMARK_HALF_LIFE_DAYS,
  MIN_OUTCOME_SAMPLES,
  type ModelCapability,
  type StaffingQuery,
  type SwarmStaffingPrefs,
} from '@/modules/swarm/model-registry.service.js';
export {
  formatRegistrySummary,
  previewAutoStaffRoster,
  staffPlanSeats,
  staffTask,
  MAX_SAME_MODEL_SEATS,
  type StaffedSeat,
  type StaffingRequest,
} from '@/modules/swarm/swarm-staffing.service.js';
export {
  buildGoalWorkshopPrompt,
  configureGoalWorkshopRunner,
  parseGoalDraft,
  runGoalWorkshop,
  type GoalWorkshopMessage,
  type GoalWorkshopResult,
} from '@/modules/swarm/swarm-goal-workshop.service.js';
export * from '@/modules/swarm/swarm.types.js';
