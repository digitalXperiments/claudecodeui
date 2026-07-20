import { appConfigDb } from '@/modules/database/index.js';
import type { ObsidianMemorySettings, ObsidianMemorySettingsStatus } from '@/shared/types.js';

/**
 * Global Obsidian connection settings.
 *
 * These are shared across every project and stored as a single JSON blob in the
 * `app_config` key-value table (same store used for the JWT secret). Kept
 * separate from per-project `project_memory` rows because the vault location and
 * Local REST API credentials are a machine-level concern the user configures
 * once, while each project only points at a folder inside that vault.
 */
const APP_CONFIG_KEY = 'obsidian_memory_settings';

const DEFAULT_SETTINGS: ObsidianMemorySettings = {
  vaultPath: '',
  restProtocol: 'http',
  restHost: '127.0.0.1',
  restPort: 27123,
  restApiKey: '',
};

const parseSettings = (raw: string | null): ObsidianMemorySettings => {
  if (!raw) {
    return { ...DEFAULT_SETTINGS };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ObsidianMemorySettings>;
    return {
      vaultPath: typeof parsed.vaultPath === 'string' ? parsed.vaultPath : DEFAULT_SETTINGS.vaultPath,
      restProtocol: parsed.restProtocol === 'https' ? 'https' : DEFAULT_SETTINGS.restProtocol,
      restHost: typeof parsed.restHost === 'string' && parsed.restHost.trim()
        ? parsed.restHost
        : DEFAULT_SETTINGS.restHost,
      restPort: Number.isFinite(parsed.restPort) ? Number(parsed.restPort) : DEFAULT_SETTINGS.restPort,
      restApiKey: typeof parsed.restApiKey === 'string' ? parsed.restApiKey : DEFAULT_SETTINGS.restApiKey,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
};

/**
 * Settings are considered complete enough to enable memory once a vault path is
 * set. REST credentials are only needed for the runtime MCP connection, so a
 * missing key still allows scaffolding but is surfaced to the UI.
 */
const isConfigured = (settings: ObsidianMemorySettings): boolean => Boolean(settings.vaultPath.trim());

export const obsidianSettingsService = {
  getSettings(): ObsidianMemorySettings {
    return parseSettings(appConfigDb.get(APP_CONFIG_KEY));
  },

  getStatus(): ObsidianMemorySettingsStatus {
    const settings = obsidianSettingsService.getSettings();
    return { ...settings, configured: isConfigured(settings) };
  },

  saveSettings(input: Partial<ObsidianMemorySettings>): ObsidianMemorySettingsStatus {
    const current = obsidianSettingsService.getSettings();
    const next: ObsidianMemorySettings = {
      vaultPath: typeof input.vaultPath === 'string' ? input.vaultPath.trim() : current.vaultPath,
      restProtocol: input.restProtocol === 'http' || input.restProtocol === 'https' ? input.restProtocol : current.restProtocol,
      restHost: typeof input.restHost === 'string' && input.restHost.trim() ? input.restHost.trim() : current.restHost,
      restPort: Number.isFinite(input.restPort) ? Number(input.restPort) : current.restPort,
      restApiKey: typeof input.restApiKey === 'string' ? input.restApiKey.trim() : current.restApiKey,
    };

    appConfigDb.set(APP_CONFIG_KEY, JSON.stringify(next));
    return { ...next, configured: isConfigured(next) };
  },

  isConfigured,
};
