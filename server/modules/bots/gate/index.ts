export { botGateRouter } from '@/modules/bots/gate/gate.routes.js';
export { botSpendDb } from '@/modules/bots/gate/bot-spend.repository.js';
export {
  SAFETY_FLOOR,
  type AutoReviewer,
  type GateContext,
  type GateRequest,
  type GateVerdict,
  type HumanGateOutcome,
  type Risk,
} from '@/modules/bots/gate/gate.types.js';
export { buildReviewerSdkOptions } from '@/modules/bots/gate/auto-reviewer.js';
export { classifyToolRisk, type ClassifyToolInput } from '@/modules/bots/gate/tool-risk.js';
export { rules, matchRules, ruleMatchesRequest, globMatches, escapeGlobLiteral } from '@/modules/bots/gate/rules.service.js';
export { budgets, wakeAllowed, type BudgetCheck } from '@/modules/bots/gate/budgets.service.js';
export { setAutoReviewer, defaultAutoReviewer, runAutoReviewer } from '@/modules/bots/gate/auto-reviewer.js';
export {
  actionGate,
  initBotGate,
  recordGateDenial,
  summarizeArgs,
  resolveBotGateDecision,
  setGateHumanPollInterval,
  setHumanWaitHooks,
  APPROVAL_FINISH_MARGIN_MS,
  type HumanWaitHooks,
  type HumanWaitInfo,
} from '@/modules/bots/gate/action-gate.service.js';
export { approvalCardTitle, describeGateAction, expiredApprovalMessage, formatWait, shortPath } from '@/modules/bots/gate/approval-text.js';
export {
  analyzeReadOnlyCall,
  analyzeReadOnlyShell,
  analyzeReadOnlyTool,
  isSkillsReadOnly,
  opaqueReadToolReason,
  outsideReadIsSafe,
  skillRoots,
  type ReadOnlyCall,
} from '@/modules/bots/gate/read-only.js';
export {
  BUILTIN_GATE_SERVER,
  builtinDenylistReason,
  builtinCallRisk,
  builtinEscalationReason,
  builtinScanEscalation,
  createBuiltinToolGate,
  protectedCommandReason,
  protectedPathReason,
  type BuiltinToolDecision,
  type BuiltinToolGate,
  type BuiltinToolGateContext,
} from '@/modules/bots/gate/builtin-tool-gate.js';
export { destructiveCommandReason, purchaseCommandReason, riskFromScan, scanShellCommand, scanToolPaths, type CommandScan } from '@/modules/bots/gate/command-risk.js';
export { PROTECTED_DIRS, PROTECTED_FILES, realPathProtectedReason } from '@/modules/bots/gate/protected-paths.js';
export {
  assessFileTool,
  assessShellCommand,
  protectedSegmentsReason,
  type StrictFinding,
  type StrictScope,
} from '@/modules/bots/gate/strict-guard.js';
