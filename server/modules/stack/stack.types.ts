export type StackMcpBinding = {
  name: string;
  enabledFor?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
};

export type StackConfig = {
  version: number;
  project: string;
  providers?: {
    required?: string[];
    optional?: string[];
    [key: string]: unknown;
  };
  mcp?: StackMcpBinding[];
  skills?: {
    global?: string[];
    project?: string[];
    [key: string]: unknown;
  };
  memory?: Record<string, unknown>;
  ship?: Record<string, unknown>;
  health?: {
    auth?: string[];
    mcp?: string[];
    [key: string]: unknown;
  };
  notifications?: Record<string, unknown>;
  profiles?: Record<string, unknown>;
  [key: string]: unknown;
};

export type StackDocument = {
  projectId: string;
  projectPath: string;
  path: string;
  exists: boolean;
  config: StackConfig;
};

export type StackDoctorCheck = {
  id: string;
  label: string;
  ok: boolean;
  status: 'pass' | 'fail' | 'skipped';
  message: string;
  details?: unknown;
  fix?: string;
};

export type StackDoctorReport = {
  projectId: string;
  projectPath: string;
  stackPath: string;
  ok: boolean;
  checks: StackDoctorCheck[];
  generatedAt: string;
  interruptIds: string[];
};

export type StackApplyResult = {
  applied: boolean;
  document: StackDocument;
  warnings: string[];
};

export type StackExportResult = {
  path: string;
  format: 'yaml';
  yaml: string;
  config: StackConfig;
};
