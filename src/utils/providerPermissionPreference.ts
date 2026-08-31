/**
 * Canonical per-provider "last used permission mode" preference.
 *
 * Some providers (Pi, Oh My Pi) previously had two independent stores for the
 * same concept: the chat composer's `permissionMode-last-<provider>` key
 * (which actually drives the session's runtime permission mode) and a
 * Settings-only `<provider>-tools-settings.permissionMode` blob that the
 * composer never read. Saving a mode in Settings silently had no effect on
 * new chats. This module makes `permissionMode-last-<provider>` the single
 * source of truth, migrates a value out of the legacy blob the first time
 * it's read, and broadcasts same-window updates so an open composer picks up
 * a Settings change immediately.
 */

export const PROVIDER_PERMISSION_PREFERENCE_CHANGED_EVENT = 'cloudcli:provider-permission-preference-changed';

export type ProviderPermissionPreferenceChangedDetail = {
  provider: string;
  mode: string;
};

const canonicalKey = (provider: string): string => `permissionMode-last-${provider}`;
const legacySettingsKey = (provider: string): string => `${provider}-tools-settings`;

/**
 * Reads the canonical last-used permission mode for `provider`. Falls back to
 * (and migrates) a `permissionMode` value from the legacy
 * `<provider>-tools-settings` blob if the canonical key has never been
 * written, then falls back to `fallback`.
 */
export function readProviderPermissionModePreference(provider: string, fallback: string): string {
  try {
    const canonical = localStorage.getItem(canonicalKey(provider));
    if (canonical) {
      return canonical;
    }

    const legacyRaw = localStorage.getItem(legacySettingsKey(provider));
    if (legacyRaw) {
      const parsed = JSON.parse(legacyRaw) as { permissionMode?: unknown };
      if (typeof parsed.permissionMode === 'string' && parsed.permissionMode) {
        localStorage.setItem(canonicalKey(provider), parsed.permissionMode);
        return parsed.permissionMode;
      }
    }
  } catch {
    // Malformed storage — fall through to the caller's default.
  }

  return fallback;
}

/**
 * Writes `mode` as the canonical last-used permission mode for `provider` and
 * notifies same-window listeners (e.g. an open chat composer) so they can
 * adopt it immediately instead of waiting for a session/provider change to
 * re-read localStorage.
 */
export function writeProviderPermissionModePreference(provider: string, mode: string): void {
  try {
    localStorage.setItem(canonicalKey(provider), mode);
  } catch {
    // ignore storage failures (private browsing quota, etc.)
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent<ProviderPermissionPreferenceChangedDetail>(PROVIDER_PERMISSION_PREFERENCE_CHANGED_EVENT, {
        detail: { provider, mode },
      }),
    );
  }
}
