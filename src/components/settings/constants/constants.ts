import type { ComponentType } from 'react';
import {
  Bell,
  Bot,
  BrainCircuit,
  FileCode2,
  FlaskConical,
  GitBranch,
  Info,
  Key,
  KeyRound,
  ListChecks,
  Mic,
  MonitorPlay,
  Palette,
  Puzzle,
  Server,
  ShieldCheck,
  UserCog,
  Webhook,
} from 'lucide-react';

import type {
  AgentCategory,
  AgentProvider,
  CodeEditorSettingsState,
  CursorPermissionsState,
  GrokPermissionsState,
  ProjectSortOrder,
  SettingsMainTab,
} from '../types/types';

export type SettingsMainTabMeta = {
  id: SettingsMainTab;
  label: string;
  keywords: string;
  icon: ComponentType<{ className?: string }>;
};

export const SETTINGS_MAIN_TABS: SettingsMainTabMeta[] = [
  { id: 'agents', label: 'Agents', keywords: 'agents subagents claude code account login', icon: Bot },
  {
    id: 'agent-profiles',
    label: 'Agent profiles',
    keywords: 'profiles model effort permissions kanban presets',
    icon: UserCog,
  },
  {
    id: 'studio',
    label: 'Studio',
    keywords: 'studio design prototype swarm seats architect builder reviewer',
    icon: Palette,
  },
  { id: 'evals', label: 'Eval Center', keywords: 'evals evaluation suites tests harness', icon: FlaskConical },
  { id: 'mcp', label: 'MCP', keywords: 'mcp servers catalog tools', icon: Server },
  { id: 'skills', label: 'Skills', keywords: 'skills skill.md project global wizard', icon: FileCode2 },
  { id: 'memory', label: 'Memory', keywords: 'memory obsidian vault second brain', icon: BrainCircuit },
  { id: 'appearance', label: 'Appearance', keywords: 'appearance theme dark light language', icon: Palette },
  { id: 'git', label: 'Git', keywords: 'git github commits', icon: GitBranch },
  { id: 'api', label: 'API Tokens', keywords: 'api tokens auth keys', icon: Key },
  { id: 'secrets', label: 'Secrets', keywords: 'secrets vault credentials env', icon: KeyRound },
  { id: 'webhooks', label: 'Webhooks', keywords: 'webhooks hooks ingest dictation automation', icon: Webhook },
  { id: 'voice', label: 'Voice', keywords: 'voice speech tts stt microphone', icon: Mic },
  { id: 'tasks', label: 'Tasks', keywords: 'tasks taskmaster', icon: ListChecks },
  { id: 'browser', label: 'Browser', keywords: 'browser playwright chromium automation', icon: MonitorPlay },
  { id: 'plugins', label: 'Plugins', keywords: 'plugins extensions integrations', icon: Puzzle },
  { id: 'notifications', label: 'Notifications', keywords: 'notifications alerts push', icon: Bell },
  { id: 'security', label: 'Security', keywords: 'security 2fa totp password', icon: ShieldCheck },
  { id: 'about', label: 'About', keywords: 'about version info', icon: Info },
];

export const AGENT_PROVIDERS: AgentProvider[] = ['claude', 'cursor', 'codex', 'opencode', 'kilo', 'cline', 'grok', 'kimi', 'qwencode', 'pi'];
export const AGENT_NAMES: Record<AgentProvider, string> = {
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
export const AGENT_CATEGORIES: AgentCategory[] = ['account', 'permissions'];

export const DEFAULT_PROJECT_SORT_ORDER: ProjectSortOrder = 'name';
export const DEFAULT_SAVE_STATUS = null;
export const DEFAULT_CODE_EDITOR_SETTINGS: CodeEditorSettingsState = {
  wordWrap: false,
  showMinimap: true,
  lineNumbers: true,
  fontSize: '14',
};

export const DEFAULT_CURSOR_PERMISSIONS: CursorPermissionsState = {
  allowedCommands: [],
  disallowedCommands: [],
  skipPermissions: false,
};

export const DEFAULT_GROK_PERMISSIONS: GrokPermissionsState = {
  allowedCommands: [],
  disallowedCommands: [],
  skipPermissions: false,
};
