import type { LLMProvider } from '../../types/app';

export type SkillsProvider = LLMProvider;
export type SkillsScope = 'user' | 'project' | 'plugin' | 'repo' | 'admin' | 'system';

export type SkillsProject = {
  projectId: string;
  displayName?: string;
  fullPath?: string;
  path?: string;
};

export type ProviderSkill = {
  provider: SkillsProvider;
  name: string;
  description: string;
  command: string;
  scope: SkillsScope;
  sourcePath: string;
  pluginName?: string;
  pluginId?: string;
  projectDisplayName?: string;
  projectPath?: string;
};

export type ProviderSkillCreateEntryPayload = {
  content: string;
  directoryName?: string;
  fileName?: string;
  files?: Array<{
    relativePath: string;
    content: string;
    encoding: 'base64';
  }>;
};

export type ProviderSkillCreatePayload = {
  entries: ProviderSkillCreateEntryPayload[];
};

export type ProviderSkillsResponse = {
  provider: SkillsProvider;
  skills: Array<Partial<ProviderSkill>>;
};

/**
 * One cross-agent project skill. Authored once and fanned out to every agent's
 * project skill folder. `providers` are the agents that received a copy;
 * `conflicts` are agents whose folder already held a non-managed skill of the
 * same name and were left untouched.
 */
export type ProjectSkill = {
  name: string;
  description: string;
  directoryName: string;
  sourcePath: string;
  providers: SkillsProvider[];
  conflicts: SkillsProvider[];
};

export type ProjectSkillCreatePayload = {
  workspacePath: string;
  entries: ProviderSkillCreateEntryPayload[];
};

export type ProjectSkillsResponse = {
  workspacePath: string;
  skills: Array<Partial<ProjectSkill>>;
};

/**
 * One cross-agent global skill. Authored once and fanned out to every agent's
 * user-scope skill folder, so it applies to every project. `unsupported` lists
 * agents that have no user-scope skill folder. `kind: 'memory-template'` marks
 * the managed memory skill template, which is edited here but never fanned out.
 */
export type GlobalSkill = {
  name: string;
  description: string;
  directoryName: string;
  sourcePath: string;
  providers: SkillsProvider[];
  conflicts: SkillsProvider[];
  unsupported: SkillsProvider[];
  kind?: 'memory-template';
};

export type GlobalSkillCreatePayload = {
  entries: ProviderSkillCreateEntryPayload[];
};

export type GlobalSkillsResponse = {
  skills: Array<Partial<GlobalSkill>>;
};

export type SkillContentResponse = {
  directoryName: string;
  content: string;
};

export type MemorySkillResyncResult = {
  workspacePath: string;
  ok: boolean;
  error?: string;
};

export type GlobalSkillContentUpdateResponse = SkillContentResponse & {
  resync: MemorySkillResyncResult[] | null;
};

export type ApiSuccessResponse<T> = {
  success: true;
  data: T;
};

export type ApiErrorResponse = {
  success: false;
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
};

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;
