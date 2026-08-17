import type { McpFormState, McpProvider, McpScope, McpTransport } from './types';

export const MCP_PROVIDER_NAMES: Record<McpProvider, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  opencode: 'OpenCode',
  kilo: 'Kilo Code',
  cline: 'Cline',
  grok: 'Grok Build',
  kimi: 'Kimi',
  qwencode: 'Qwen Code',
  pi: 'Pi',
};

export const MCP_SUPPORTED_SCOPES: Record<McpProvider, McpScope[]> = {
  claude: ['user', 'project', 'local'],
  cursor: ['user', 'project'],
  codex: ['user', 'project'],
  opencode: ['user', 'project'],
  kilo: ['user', 'project'],
  cline: ['user'],
  grok: ['user', 'project'],
  kimi: ['user', 'project'],
  qwencode: ['user', 'project'],
  pi: [],
};

export const MCP_SUPPORTED_TRANSPORTS: Record<McpProvider, McpTransport[]> = {
  claude: ['stdio', 'http', 'sse'],
  cursor: ['stdio', 'http'],
  codex: ['stdio', 'http'],
  opencode: ['stdio', 'http'],
  kilo: ['stdio', 'http'],
  cline: ['stdio', 'http'],
  grok: ['stdio', 'http'],
  kimi: ['stdio', 'http'],
  qwencode: ['stdio', 'http', 'sse'],
  pi: [],
};

export const MCP_GLOBAL_SUPPORTED_SCOPES: McpScope[] = ['user', 'project'];

export const MCP_GLOBAL_SUPPORTED_TRANSPORTS: McpTransport[] = ['stdio', 'http'];

export const MCP_PROVIDER_BUTTON_CLASSES: Record<McpProvider, string> = {
  claude: 'bg-primary text-primary-foreground hover:bg-primary/90',
  cursor: 'bg-primary text-primary-foreground hover:bg-primary/90',
  codex: 'bg-primary text-primary-foreground hover:bg-primary/90',
  opencode: 'bg-primary text-primary-foreground hover:bg-primary/90',
  kilo: 'bg-primary text-primary-foreground hover:bg-primary/90',
  cline: 'bg-primary text-primary-foreground hover:bg-primary/90',
  grok: 'bg-primary text-primary-foreground hover:bg-primary/90',
  kimi: 'bg-primary text-primary-foreground hover:bg-primary/90',
  qwencode: 'bg-primary text-primary-foreground hover:bg-primary/90',
  pi: 'bg-primary text-primary-foreground hover:bg-primary/90',
};

export const MCP_SUPPORTS_WORKING_DIRECTORY: Record<McpProvider, boolean> = {
  claude: false,
  cursor: false,
  codex: true,
  opencode: false,
  kilo: false,
  cline: false,
  grok: false,
  kimi: false,
  qwencode: false,
  pi: false,
};

export const DEFAULT_MCP_FORM: McpFormState = {
  name: '',
  scope: 'user',
  workspacePath: '',
  transport: 'stdio',
  command: '',
  args: [],
  env: {},
  cwd: '',
  url: '',
  headers: {},
  envVars: [],
  bearerTokenEnvVar: '',
  envHttpHeaders: {},
  importMode: 'form',
  jsonInput: '',
};
