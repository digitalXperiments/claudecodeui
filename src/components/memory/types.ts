import type { LLMProvider } from '../../types/app';

export type MemoryProject = {
  projectId: string;
  displayName: string;
  fullPath?: string;
  path?: string;
};

export type ObsidianMemorySettings = {
  vaultPath: string;
  restProtocol: 'http' | 'https';
  restHost: string;
  restPort: number;
  restApiKey: string;
  configured: boolean;
};

export type ProjectMemoryStatus = {
  workspacePath: string;
  enabled: boolean;
  vaultFolder: string;
  vaultPath: string | null;
  settingsConfigured: boolean;
  providers: LLMProvider[];
  skillInstalled: boolean;
};

export type ApiResponse<TData> = {
  success: boolean;
  data: TData;
  error?: { message?: string } | string;
};

export type ObsidianSettingsResponse = {
  settings: ObsidianMemorySettings;
};

export type ProjectMemoryStatusResponse = {
  status: ProjectMemoryStatus;
};

export type ObsidianConnectionTestResult = {
  ok: boolean;
  vaultName?: string;
  version?: string;
  error?: string;
};

export type ObsidianConnectionTestResponse = {
  result: ObsidianConnectionTestResult;
};

export type ProjectMemoryVaultStats = {
  workspacePath: string;
  vaultFolder: string;
  exists: boolean;
  decisions: number;
  entities: number;
  sessions: number;
  lastSessionWrite: string | null;
};

export type ProjectMemoryVaultStatsResponse = {
  stats: ProjectMemoryVaultStats;
};
