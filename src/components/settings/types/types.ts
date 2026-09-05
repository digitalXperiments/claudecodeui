import type { Dispatch, SetStateAction } from 'react';

import type { LLMProvider } from '../../../types/app';
import type { ProviderAuthStatus } from '../../provider-auth/types';

export type SettingsMainTab = 'agents' | 'agent-profiles' | 'continuity' | 'studio' | 'evals' | 'mcp' | 'skills' | 'global-skills' | 'memory' | 'appearance' | 'git' | 'api' | 'secrets' | 'voice' | 'tasks' | 'browser' | 'notifications' | 'plugins' | 'webhooks' | 'backups' | 'security' | 'about';
export type AgentProvider = LLMProvider;
/** Agent settings categories — MCP and Skills live in dedicated top-level tabs. */
export type AgentCategory = 'account' | 'permissions' | 'models';
export type ProjectSortOrder = 'name' | 'date';
export type SaveStatus = 'success' | 'error' | null;
export type CodexPermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions';
// Pi has no permission popups; plan = read-only tools, bypass = full tool set.
export type PiPermissionMode = 'plan' | 'bypassPermissions';
// Oh My Pi is a Pi fork and exposes the same two modes.
export type OmpPermissionMode = 'plan' | 'bypassPermissions';
// Mirrors the kilo entry in provider-capabilities.service.ts (KILO_PERMISSION
// policy + ACP build/plan agent — see resolveKiloPermissionPolicy).
export type KiloPermissionMode = 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'plan';
// Mirrors the opencode entry in provider-capabilities.service.ts
// (OPENCODE_PERMISSION policy + ACP build/plan agent). No bypass mode: `auto`
// still honours the user's own deny rules.
export type OpenCodePermissionMode = 'default' | 'acceptEdits' | 'auto' | 'plan';
// Mirrors the antigravity entry in provider-capabilities.service.ts (ACP
// session modes default / auto_edit / yolo). Antigravity has no read-only
// agent, so there is no plan mode.
export type AntigravityPermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions';

export type SettingsProject = {
  projectId?: string;
  name: string;
  displayName?: string;
  fullPath?: string;
  path?: string;
};

export type AuthStatus = ProviderAuthStatus;

export type ClaudePermissionsState = {
  allowedTools: string[];
  disallowedTools: string[];
  skipPermissions: boolean;
};

export type NotificationChannelRule = {
  channel: string;
  kinds: string[];
  sources: string[];
  enabled: boolean;
};

export type NotificationDigestPreferences = {
  enabled: boolean;
  time: string;
  channels: string[];
};

export type NotificationPreferencesState = {
  channels: {
    inApp: boolean;
    webPush: boolean;
    desktop: boolean;
    sound: boolean;
  };
  events: {
    actionRequired: boolean;
    stop: boolean;
    error: boolean;
  };
  rules: NotificationChannelRule[];
  digest?: NotificationDigestPreferences;
};

export type CursorPermissionsState = {
  allowedCommands: string[];
  disallowedCommands: string[];
  skipPermissions: boolean;
};

export type GrokPermissionsState = {
  allowedCommands: string[];
  disallowedCommands: string[];
  skipPermissions: boolean;
};

export type CodeEditorSettingsState = {
  wordWrap: boolean;
  showMinimap: boolean;
  lineNumbers: boolean;
  fontSize: string;
};

export type SettingsStoragePayload = {
  claude: ClaudePermissionsState & { projectSortOrder: ProjectSortOrder; lastUpdated: string };
  cursor: CursorPermissionsState & { lastUpdated: string };
  codex: { permissionMode: CodexPermissionMode; lastUpdated: string };
  grok: GrokPermissionsState & { lastUpdated: string };
  pi: { permissionMode: PiPermissionMode; lastUpdated: string };
  omp: { permissionMode: OmpPermissionMode; lastUpdated: string };
};

export type SettingsProps = {
  isOpen: boolean;
  onClose: () => void;
  projects?: SettingsProject[];
  initialTab?: string;
};

export type SetState<T> = Dispatch<SetStateAction<T>>;
