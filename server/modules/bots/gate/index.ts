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
export { classifyToolRisk, type ClassifyToolInput } from '@/modules/bots/gate/tool-risk.js';
export { rules, matchRules, ruleMatchesRequest, globMatches } from '@/modules/bots/gate/rules.service.js';
export { budgets, wakeAllowed, type BudgetCheck } from '@/modules/bots/gate/budgets.service.js';
export { setAutoReviewer, defaultAutoReviewer, runAutoReviewer } from '@/modules/bots/gate/auto-reviewer.js';
export {
  actionGate,
  initBotGate,
  resolveBotGateDecision,
  setGateHumanPollInterval,
} from '@/modules/bots/gate/action-gate.service.js';
