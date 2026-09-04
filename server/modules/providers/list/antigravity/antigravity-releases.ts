/**
 * Pinned Google Antigravity ACP runtime artifacts.
 *
 * CloudCLI installs Antigravity the way T3 Code (pingdotgg/t3code) does: it
 * downloads the *official* Google archive for the current host, verifies it
 * against a pin (SHA-256 **and** byte size) that ships inside this repo, and
 * extracts the ACP executable plus its `localharness_external` sidecar into
 * `~/.cloudcli/antigravity/<version>/`. Nothing is ever installed from an
 * unpinned artifact — a missing pin is a hard failure, not a "download anyway"
 * fallback, because the pin is the only thing that makes the download
 * trustworthy.
 *
 * ## Filling in the pins
 *
 * The pins below are intentionally EMPTY. They must be copied verbatim from the
 * Antigravity installer in T3 Code's `main` branch (the file that lists the ACP
 * registry download URLs together with their `sha256` and `size` for
 * `darwin-arm64`, `linux-x64`, `linux-arm64`, `win32-x64`, `win32-arm64`) and
 * NOT hand-computed from a local download — a local hash only proves that the
 * bytes we already have hash to themselves.
 *
 * Until they are filled in, `Install` reports
 * `ANTIGRAVITY_RUNTIME_NOT_PINNED` and explains how to supply pins. Operators
 * who have their own verified pins can point
 * `CLOUDCLI_ANTIGRAVITY_MANIFEST` at a JSON file with the same shape (see
 * `readAntigravityManifestOverride`) instead of waiting for a CloudCLI release.
 *
 * Deliberate non-goals:
 * - No `darwin-x64` (Intel Mac) artifact. Google does not publish one, and
 *   guessing a URL would break in a way that looks like a CloudCLI bug.
 * - No Gemini API-key path. Antigravity in CloudCLI is personal-Google OAuth
 *   only, so an unavailable runtime never silently becomes metered API billing.
 */

import { readFileSync } from 'node:fs';

/** Host keys Google publishes an Antigravity ACP archive for. */
export type AntigravityPlatformKey =
  | 'darwin-arm64'
  | 'linux-x64'
  | 'linux-arm64'
  | 'win32-x64'
  | 'win32-arm64';

export const ANTIGRAVITY_PLATFORM_KEYS: readonly AntigravityPlatformKey[] = [
  'darwin-arm64',
  'linux-x64',
  'linux-arm64',
  'win32-x64',
  'win32-arm64',
];

/**
 * One verified download. `sha256` is lowercase hex of the archive and `size` is
 * its exact byte length; both are checked, because a truncated download can
 * still be made to collide with a prefix-only check.
 */
export type AntigravityArtifactPin = {
  url: string;
  sha256: string;
  size: number;
};

export type AntigravityManifest = {
  version: string;
  artifacts: Partial<Record<AntigravityPlatformKey, AntigravityArtifactPin>>;
};

/**
 * Runtime version CloudCLI targets. Matches the Antigravity ACP runtime T3 Code
 * pins on `main` (1.1.1). Bumping this requires new pins for every platform.
 */
export const ANTIGRAVITY_RUNTIME_VERSION = '1.1.1';

/**
 * TODO(antigravity-pins): populate from T3 Code `main`'s Antigravity installer
 * for runtime 1.1.1. One entry per supported host; every field is required.
 * Leaving an entry out means "CloudCLI cannot install this host's runtime yet",
 * which is reported honestly instead of attempting an unverified download.
 */
export const ANTIGRAVITY_ARTIFACTS: Partial<Record<AntigravityPlatformKey, AntigravityArtifactPin>> = {
  // 'darwin-arm64': { url: '', sha256: '', size: 0 },
  // 'linux-x64':    { url: '', sha256: '', size: 0 },
  // 'linux-arm64':  { url: '', sha256: '', size: 0 },
  // 'win32-x64':    { url: '', sha256: '', size: 0 },
  // 'win32-arm64':  { url: '', sha256: '', size: 0 },
};

export const BUILT_IN_ANTIGRAVITY_MANIFEST: AntigravityManifest = {
  version: ANTIGRAVITY_RUNTIME_VERSION,
  artifacts: ANTIGRAVITY_ARTIFACTS,
};

/** Map a Node platform/arch pair onto the artifact key, or null when unsupported. */
export function antigravityPlatformKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): AntigravityPlatformKey | null {
  if (platform === 'darwin') {
    // Intel Macs are deliberately unsupported (see file header).
    return arch === 'arm64' ? 'darwin-arm64' : null;
  }
  if (platform === 'linux') {
    if (arch === 'x64') return 'linux-x64';
    if (arch === 'arm64') return 'linux-arm64';
    return null;
  }
  if (platform === 'win32') {
    if (arch === 'x64') return 'win32-x64';
    if (arch === 'arm64') return 'win32-arm64';
    return null;
  }
  return null;
}

const isPlatformKey = (value: unknown): value is AntigravityPlatformKey =>
  typeof value === 'string' && (ANTIGRAVITY_PLATFORM_KEYS as readonly string[]).includes(value);

/**
 * A pin is usable only when all three fields are present and well formed. A
 * half-filled pin (URL but no hash) is treated as absent so it can never
 * downgrade the install into an unverified download.
 */
export function isUsableArtifactPin(pin: unknown): pin is AntigravityArtifactPin {
  if (!pin || typeof pin !== 'object') return false;
  const candidate = pin as Record<string, unknown>;
  if (typeof candidate.url !== 'string' || !/^https:\/\//.test(candidate.url)) return false;
  if (typeof candidate.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(candidate.sha256)) return false;
  return typeof candidate.size === 'number' && Number.isInteger(candidate.size) && candidate.size > 0;
}

/**
 * Optional operator-supplied manifest, so a verified pin can be used before the
 * constants above are updated. Malformed files are ignored rather than throwing:
 * a bad override must not take the whole provider list down.
 */
export function readAntigravityManifestOverride(
  env: NodeJS.ProcessEnv = process.env,
): AntigravityManifest | null {
  const manifestPath = env.CLOUDCLI_ANTIGRAVITY_MANIFEST?.trim();
  if (!manifestPath) return null;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    const rawArtifacts = parsed.artifacts && typeof parsed.artifacts === 'object'
      ? parsed.artifacts as Record<string, unknown>
      : {};
    const artifacts: Partial<Record<AntigravityPlatformKey, AntigravityArtifactPin>> = {};
    for (const [key, value] of Object.entries(rawArtifacts)) {
      if (isPlatformKey(key) && isUsableArtifactPin(value)) {
        artifacts[key] = { url: value.url, sha256: value.sha256.toLowerCase(), size: value.size };
      }
    }
    const version = typeof parsed.version === 'string' && parsed.version.trim()
      ? parsed.version.trim()
      : ANTIGRAVITY_RUNTIME_VERSION;
    return { version, artifacts };
  } catch {
    return null;
  }
}

/** The manifest in force: operator override when valid, otherwise the built-in pins. */
export function resolveAntigravityManifest(env: NodeJS.ProcessEnv = process.env): AntigravityManifest {
  return readAntigravityManifestOverride(env) ?? BUILT_IN_ANTIGRAVITY_MANIFEST;
}

/**
 * Pin for one host, or null when this host has no pin. Callers must treat null
 * as "cannot install", never as "install without verification".
 */
export function resolveAntigravityArtifact(
  key: AntigravityPlatformKey | null,
  env: NodeJS.ProcessEnv = process.env,
): AntigravityArtifactPin | null {
  if (!key) return null;
  const pin = resolveAntigravityManifest(env).artifacts[key];
  return isUsableArtifactPin(pin) ? { ...pin, sha256: pin.sha256.toLowerCase() } : null;
}
