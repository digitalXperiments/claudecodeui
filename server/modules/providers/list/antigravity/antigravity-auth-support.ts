/**
 * Launch environment and OAuth URL capture for the official Antigravity ACP
 * agent. Mirrors T3 Code's AntigravityAuthSupport:
 *
 *  - a private GEMINI_HOME with AGY_ACP_FORCE_FILE_STORAGE so tokens persist
 *    as a file, not a host keychain entry the next process cannot read;
 *  - a BROWSER helper that prints the consent URL instead of opening a real
 *    browser (which is how marketing pages like g1-upgrade leaked into Settings);
 *  - strip ambient GOOGLE and GEMINI API keys so an unsigned agent cannot silently
 *    fall onto metered API billing;
 *  - accept only Google's ACP OAuth URL shape (`/o/oauth2/v2/auth` + loopback
 *    redirect_uri), optionally prefixed the way 1.1.1 prints it.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  ANTIGRAVITY_HARNESS_NAME,
  antigravityInstallRoot,
} from './antigravity-runtime.js';

export const ANTIGRAVITY_AUTH_STDOUT_PREFIX =
  'Open the following link to authenticate the ACP server: ';
export const ANTIGRAVITY_AUTH_BROWSER_MARKER = '__CLOUDCLI_ANTIGRAVITY_AUTH_URL__';

const REMOVED_ENV_KEYS = new Set([
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_CLOUD_QUOTA_PROJECT',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GCLOUD_PROJECT',
  'CLOUDSDK_CORE_PROJECT',
  'AGY_ACP_CCPA_PROJECT',
  'AGY_ACP_ENABLE_OAUTH',
  'GEMINI_HOME',
  'AGY_ACP_FORCE_FILE_STORAGE',
  'ANTIGRAVITY_HARNESS_PATH',
  'BROWSER',
  'PYTHONUNBUFFERED',
  'ELECTRON_RUN_AS_NODE',
]);

export type AntigravityAuthorizationUrl = {
  authorizationUrl: string;
  redirectUri: string;
  state: string;
};

const quoteBrowserArgument = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

const browserHelperSource =
  `process.stderr.on("error",()=>process.exit(0)).write(`
  + `"${ANTIGRAVITY_AUTH_BROWSER_MARKER}"+JSON.stringify(process.argv[1])+"\\n",`
  + `()=>process.exit(0))`;

export function antigravityProfileDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(antigravityInstallRoot(env), 'profile');
}

export function parseAntigravityAuthorizationUrl(authorizationUrl: string): AntigravityAuthorizationUrl | null {
  if (typeof authorizationUrl !== 'string' || !authorizationUrl) return null;
  if (authorizationUrl.length > 16_384 || /\s/.test(authorizationUrl)) return null;
  let url: URL;
  try {
    url = new URL(authorizationUrl);
  } catch {
    return null;
  }
  const state = url.searchParams.get('state');
  const redirectUri = url.searchParams.get('redirect_uri');
  if (
    url.origin !== 'https://accounts.google.com'
    || url.pathname !== '/o/oauth2/v2/auth'
    || url.username !== ''
    || url.password !== ''
    || url.hash !== ''
    || url.searchParams.getAll('state').length !== 1
    || url.searchParams.getAll('redirect_uri').length !== 1
    || url.searchParams.getAll('response_type').length !== 1
    || url.searchParams.get('response_type') !== 'code'
    || !state
    || state.length > 512
    || /\s/.test(state)
    || !redirectUri
    || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/$/.test(redirectUri)
  ) {
    return null;
  }
  try {
    const redirect = new URL(redirectUri);
    if (Number(redirect.port) < 1024) return null;
  } catch {
    return null;
  }
  return { authorizationUrl, redirectUri, state };
}

/**
 * Pull the first real ACP consent URL out of agent stdout/stderr.
 *
 * Matches T3: the official prefix line, the BROWSER-helper marker, or any
 * URL that is itself a valid `/o/oauth2/v2/auth` request with a loopback
 * redirect. Marketing hosts never pass that parse.
 */
export function extractOauthUrl(text: string): string | null {
  if (typeof text !== 'string' || !text) return null;
  const clean = text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');

  for (const line of clean.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith(ANTIGRAVITY_AUTH_STDOUT_PREFIX)) {
      const parsed = parseAntigravityAuthorizationUrl(
        trimmed.slice(ANTIGRAVITY_AUTH_STDOUT_PREFIX.length).trim(),
      );
      if (parsed) return parsed.authorizationUrl;
    }
    if (trimmed.startsWith(ANTIGRAVITY_AUTH_BROWSER_MARKER)) {
      try {
        const raw = JSON.parse(trimmed.slice(ANTIGRAVITY_AUTH_BROWSER_MARKER.length));
        const parsed = parseAntigravityAuthorizationUrl(typeof raw === 'string' ? raw : '');
        if (parsed) return parsed.authorizationUrl;
      } catch {
        // Not a helper line.
      }
    }
  }

  const matches = clean.match(/https?:\/\/[^\s"'<>)\]]+/g);
  if (!matches) return null;
  for (const candidate of matches) {
    const parsed = parseAntigravityAuthorizationUrl(candidate.replace(/[.,;:]+$/, ''));
    if (parsed) return parsed.authorizationUrl;
  }
  return null;
}

const buildBrowserCommand = (execPath: string, platform: NodeJS.Platform): string => {
  const helperExecutable = platform === 'win32' ? execPath.replaceAll('\\', '/') : execPath;
  const browserArguments = [helperExecutable, '-e', browserHelperSource, '--', '%s'];
  return browserArguments.map(quoteBrowserArgument).join(' ');
};

export function antigravityHarnessPathForBinary(binaryPath: string): string | null {
  const sibling = path.join(path.dirname(binaryPath), ANTIGRAVITY_HARNESS_NAME);
  return fs.existsSync(sibling) ? sibling : null;
}

export function prepareAntigravityProfile(env: NodeJS.ProcessEnv = process.env): {
  geminiHome: string;
  acpDirectory: string;
  tokenPath: string;
} {
  const geminiHome = antigravityProfileDirectory(env);
  const acpDirectory = path.join(geminiHome, 'antigravity-acp');
  fs.mkdirSync(acpDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(geminiHome, 0o700);
      fs.chmodSync(acpDirectory, 0o700);
    } catch {
      // Best-effort on filesystems that ignore chmod.
    }
  }
  const settingsPath = path.join(acpDirectory, 'settings.json');
  fs.writeFileSync(settingsPath, `${JSON.stringify({ auth: { type: 'oauth-personal' } })}\n`, 'utf8');
  return {
    geminiHome,
    acpDirectory,
    tokenPath: path.join(acpDirectory, 'acp_token.json'),
  };
}

/** Env the ACP child must run with so login and chat share the same token file. */
export function buildAntigravityLaunchEnv(
  env: NodeJS.ProcessEnv = process.env,
  binaryPath?: string,
): NodeJS.ProcessEnv {
  const profile = prepareAntigravityProfile(env);
  const cleaned: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!REMOVED_ENV_KEYS.has(key.toUpperCase()) && !REMOVED_ENV_KEYS.has(key)) {
      cleaned[key] = value;
    }
  }
  const harness = binaryPath ? antigravityHarnessPathForBinary(binaryPath) : null;
  const launch: NodeJS.ProcessEnv = {
    ...cleaned,
    GEMINI_HOME: profile.geminiHome,
    AGY_ACP_FORCE_FILE_STORAGE: '1',
    BROWSER: buildBrowserCommand(process.execPath, process.platform),
    PYTHONUNBUFFERED: '1',
    ELECTRON_RUN_AS_NODE: '1',
  };
  if (harness) launch.ANTIGRAVITY_HARNESS_PATH = harness;
  return launch;
}

export function antigravityTokenFileExists(env: NodeJS.ProcessEnv = process.env): boolean {
  const tokenPath = path.join(antigravityProfileDirectory(env), 'antigravity-acp', 'acp_token.json');
  try {
    return fs.statSync(tokenPath).isFile() && fs.statSync(tokenPath).size > 2;
  } catch {
    return false;
  }
}

export function isLoopbackReturnUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1' || url.hostname === '[::1]';
  } catch {
    return false;
  }
}

/** Exported for tests that assert we never inherit host billing keys. */
export function strippedAntigravityEnvKeys(): string[] {
  return [...REMOVED_ENV_KEYS];
}
