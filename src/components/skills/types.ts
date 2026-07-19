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
