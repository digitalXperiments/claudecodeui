export { default as workspacesRoutes } from '@/modules/workspaces/workspaces.routes.js';
export { workspaceService, createWorkspaceService } from '@/modules/workspaces/workspace.service.js';
export {
  integrationRehearsalService,
  createIntegrationRehearsalService,
} from '@/modules/workspaces/integration-rehearsal.service.js';
export * from '@/modules/workspaces/integration-rehearsal.types.js';
export { workspaceDb } from '@/modules/workspaces/workspace.repository.js';
export {
  runGit,
  runGitOrThrow,
  isGitRepo,
  currentBranch,
  parseRemoteSlug,
  remoteRepoSlug,
} from '@/modules/workspaces/workspace-git.service.js';
export type { GitResult } from '@/modules/workspaces/workspace-git.service.js';
export * from '@/modules/workspaces/workspace.types.js';
