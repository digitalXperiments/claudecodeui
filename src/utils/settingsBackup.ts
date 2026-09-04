const BACKUP_FORMAT = 'cloudcli-preferences';
const BACKUP_VERSION = 1;
const MAX_BACKUP_BYTES = 1024 * 1024;
const MAX_PREFERENCE_VALUE_BYTES = 256 * 1024;

const PROVIDERS = [
  'claude',
  'cursor',
  'codex',
  'opencode',
  'kilo',
  'cline',
  'grok',
  'kimi',
  'qwencode',
  'pi',
  'omp',
  'antigravity',
] as const;

const PORTABLE_PREFERENCE_KEYS = new Set([
  'activeTab',
  'cloudcli.chat.isolatedWorkspace',
  'codeEditorFontSize',
  'codeEditorLineNumbers',
  'codeEditorShowMinimap',
  'codeEditorWordWrap',
  'disabledAgents',
  'file-tree-view-mode',
  'kanban.generateTaskFields.provider',
  'notificationSoundEnabled',
  'provider-usage-disabled-providers',
  'provider-usage-legend-collapsed',
  'quickSettingsHandlePosition',
  'selected-provider',
  'sidebarCollapsedCategories',
  'sidebarPanelWidth',
  'sidebarProjectsPanelCollapsed',
  'tasks-enabled',
  'theme',
  'uiPreferences',
  'userLanguage',
]);

const PROVIDER_PREFERENCE_KEYS = new Set(
  PROVIDERS.flatMap((provider) => [
    `${provider}-effort`,
    `${provider}-hidden-models`,
    `${provider}-model`,
    `${provider}-settings`,
    `${provider}-tools-settings`,
    `permissionMode-last-${provider}`,
  ]),
);

export type CloudCliPreferencesBackup = {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  sourceOrigin: string;
  preferences: Record<string, string>;
};

export type RestorePreferencesResult = {
  restored: number;
  sourceOrigin: string;
};

export function isPortablePreferenceKey(key: string): boolean {
  return PORTABLE_PREFERENCE_KEYS.has(key) || PROVIDER_PREFERENCE_KEYS.has(key);
}

export function createPreferencesBackup(
  storage: Pick<Storage, 'getItem' | 'key' | 'length'>,
  sourceOrigin: string,
  exportedAt = new Date().toISOString(),
): CloudCliPreferencesBackup {
  const preferences: Record<string, string> = {};

  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key || !isPortablePreferenceKey(key)) continue;

    const value = storage.getItem(key);
    if (value !== null) preferences[key] = value;
  }

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt,
    sourceOrigin,
    preferences,
  };
}

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('This is not a valid CloudCLI preferences backup.');
  }
}

export function parsePreferencesBackup(contents: string): CloudCliPreferencesBackup {
  if (new Blob([contents]).size > MAX_BACKUP_BYTES) {
    throw new Error('The preferences backup is too large.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error('The selected file is not valid JSON.');
  }

  assertRecord(parsed);
  if (parsed.format !== BACKUP_FORMAT || parsed.version !== BACKUP_VERSION) {
    throw new Error('This file is not a supported CloudCLI preferences backup.');
  }
  if (typeof parsed.sourceOrigin !== 'string' || typeof parsed.exportedAt !== 'string') {
    throw new Error('The CloudCLI preferences backup is incomplete.');
  }

  assertRecord(parsed.preferences);
  const preferences: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.preferences)) {
    if (!isPortablePreferenceKey(key) || typeof value !== 'string') continue;
    if (new Blob([value]).size > MAX_PREFERENCE_VALUE_BYTES) {
      throw new Error(`The preference "${key}" is too large to restore.`);
    }
    preferences[key] = value;
  }

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: parsed.exportedAt,
    sourceOrigin: parsed.sourceOrigin,
    preferences,
  };
}

export function restorePreferencesBackup(
  storage: Pick<Storage, 'setItem'>,
  contents: string,
): RestorePreferencesResult {
  const backup = parsePreferencesBackup(contents);
  const entries = Object.entries(backup.preferences);

  for (const [key, value] of entries) {
    storage.setItem(key, value);
  }

  return {
    restored: entries.length,
    sourceOrigin: backup.sourceOrigin,
  };
}

