import type { LLMProvider } from '../../types/app';

export type McpProvider = LLMProvider;
export type McpScope = 'user' | 'local' | 'project';
export type McpTransport = 'stdio' | 'http' | 'sse';
export type McpImportMode = 'form' | 'json';
export type McpFormMode = 'provider' | 'global';
export type KeyValueMap = Record<string, string>;

// Internal MCP shape; `projectId` replaces the legacy `name` field from the
// projectName → projectId migration.
export type McpProject = {
  projectId: string;
  displayName?: string;
  fullPath?: string;
  path?: string;
};

export type ProviderMcpServer = {
  provider: McpProvider;
  name: string;
  scope: McpScope;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: KeyValueMap;
  cwd?: string;
  url?: string;
  headers?: KeyValueMap;
  envVars?: string[];
  bearerTokenEnvVar?: string;
  envHttpHeaders?: KeyValueMap;
  workspacePath?: string;
  projectName?: string;
  projectDisplayName?: string;
};

export type McpFormState = {
  name: string;
  scope: McpScope;
  workspacePath: string;
  transport: McpTransport;
  command: string;
  args: string[];
  env: KeyValueMap;
  cwd: string;
  url: string;
  headers: KeyValueMap;
  envVars: string[];
  bearerTokenEnvVar: string;
  envHttpHeaders: KeyValueMap;
  importMode: McpImportMode;
  jsonInput: string;
};

export type UpsertProviderMcpServerPayload = {
  name: string;
  scope: McpScope;
  transport: McpTransport;
  workspacePath?: string;
  command?: string;
  args?: string[];
  env?: KeyValueMap;
  cwd?: string;
  url?: string;
  headers?: KeyValueMap;
  envVars?: string[];
  bearerTokenEnvVar?: string;
  envHttpHeaders?: KeyValueMap;
};

export type GlobalMcpServerResult = {
  provider: McpProvider;
  created: boolean;
  error?: string;
};

export type McpCatalogBinding = {
  enabled: boolean;
};

export type McpCatalogSyncResult = {
  provider: McpProvider;
  ok: boolean;
  error?: string;
};

export type McpCatalogEntry = {
  name: string;
  transport: McpTransport;
  scope: Exclude<McpScope, 'local'>;
  workspacePath?: string;
  command?: string;
  args?: string[];
  env?: KeyValueMap;
  cwd?: string;
  url?: string;
  headers?: KeyValueMap;
  bindings: Partial<Record<McpProvider, McpCatalogBinding>>;
  source: 'cloudcli';
  updatedAt?: string;
  syncResults?: McpCatalogSyncResult[];
};

export type McpInventorySource = 'cloudcli' | 'provider_cloud' | 'provider_native' | 'managed';

export type McpInventoryItem = {
  name: string;
  source: McpInventorySource;
  transport?: McpTransport;
  scope?: McpScope;
  command?: string;
  args?: string[];
  env?: KeyValueMap;
  cwd?: string;
  url?: string;
  headers?: KeyValueMap;
  workspacePath?: string;
  providers: McpProvider[];
  bindings?: Partial<Record<McpProvider, McpCatalogBinding>>;
  connected?: boolean | null;
  needsAuth?: boolean;
  originProvider?: McpProvider;
  kind?: 'memory';
  cloudLabel?: string;
  /** Real config file paths this row was read from. */
  configPaths?: string[];
  /** Kind tags for each path (catalog, claude_user, grok_user, mcp_json, …). */
  configKinds?: string[];
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
