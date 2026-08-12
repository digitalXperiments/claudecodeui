export { default as agentProfilesRoutes } from '@/modules/agent-profiles/agent-profiles.routes.js';
export {
  agentRunProfilesDb,
  compilePermissionIntent,
  isSwarmProfileRole,
  SWARM_PROFILE_ROLES,
} from '@/modules/database/index.js';
export {
  compilePermissionsWithClaude,
} from '@/modules/agent-profiles/compile-permissions-claude.service.js';
export type {
  AgentRunProfile,
  CreateAgentRunProfileInput,
  SwarmProfileRole,
  UpdateAgentRunProfileInput,
} from '@/modules/database/index.js';
export type {
  CompilePermissionsResult,
  CompiledPermissions,
} from '@/modules/agent-profiles/compile-permissions-claude.service.js';
