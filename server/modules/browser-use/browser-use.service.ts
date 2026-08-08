import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// cross-spawn: drop-in spawn with Windows .cmd/PATHEXT resolution.
import spawn from 'cross-spawn';

import { appConfigDb, systemNotificationsDb } from '@/modules/database/index.js';
import { providerMcpService } from '@/modules/providers/index.js';
import { getModuleDir } from '@/utils/runtime-paths.js';
import {
  BrowserConsoleBuffer,
  normalizeConsoleLevel,
  type BrowserConsoleLevel,
} from '@/modules/browser-use/browser-use.console.js';
import {
  analyzeNetworkRequests,
  assembleHar,
  filterNetworkRequests,
  NetworkCapture,
  parseHar,
  serializeNetworkRequest,
  summarizeNetworkRequest,
  type NetworkFilter,
} from '@/modules/browser-use/browser-use.network.js';
import {
  PendingInputStore,
  type CreateBrowserHumanPromptInput,
} from '@/modules/browser-use/browser-use.prompts.js';

const require = createRequire(import.meta.url);
const __dirname = getModuleDir(import.meta.url);
const IS_PLATFORM = process.env.VITE_IS_PLATFORM === 'true';
const MAX_SESSIONS_PER_OWNER = Number.parseInt(process.env.CLOUDCLI_BROWSER_USE_MAX_SESSIONS_PER_OWNER || '3', 10);
const SESSION_TTL_MS = Number.parseInt(process.env.CLOUDCLI_BROWSER_USE_SESSION_TTL_MS || String(30 * 60 * 1000), 10);
const parsedConsoleMaxMessages = Number.parseInt(process.env.CLOUDCLI_BROWSER_USE_CONSOLE_MAX_MESSAGES || '500', 10);
const CONSOLE_MAX_MESSAGES = Number.isFinite(parsedConsoleMaxMessages) ? parsedConsoleMaxMessages : 500;
const BROWSER_USE_SETTINGS_KEY = 'browser_use_settings';
const BROWSER_USE_MCP_TOKEN_KEY = 'browser_use_mcp_token';
const NETWORK_RECORDING_DEFAULT = process.env.CLOUDCLI_BROWSER_USE_NETWORK_RECORDING !== 'false';
const SESSION_WORKSPACE_ROOT = path.resolve(
  process.env.CLOUDCLI_BROWSER_USE_SESSION_WORKSPACE_ROOT
    || path.join(os.tmpdir(), 'cloudcli-browser-sessions'),
);
const parsedHarMaxBytes = Number.parseInt(process.env.CLOUDCLI_BROWSER_USE_MAX_HAR_BYTES || String(25 * 1024 * 1024), 10);
const MAX_HAR_BYTES = Number.isFinite(parsedHarMaxBytes) && parsedHarMaxBytes > 0 ? parsedHarMaxBytes : 25 * 1024 * 1024;

type BrowserUseRuntime = 'cloud' | 'local';
type BrowserUseSessionStatus = 'ready' | 'stopped' | 'unavailable';

type BrowserUseSession = {
  id: string;
  ownerId: string;
  createdBy: 'agent';
  runtime: BrowserUseRuntime;
  status: BrowserUseSessionStatus;
  url: string | null;
  title: string | null;
  screenshotDataUrl: string | null;
  createdAt: string;
  updatedAt: string;
  lastAction: string | null;
  message: string | null;
  profileName: string | null;
  viewport: {
    width: number;
    height: number;
  } | null;
  cursor: {
    x: number;
    y: number;
    actor: 'agent';
  } | null;
  workspacePath: string;
  networkRecording: boolean;
};

type PublicBrowserUseSession = Omit<BrowserUseSession, 'ownerId'>;

type RuntimeHandle = {
  browser?: any;
  context?: any;
  page?: any;
};

type DialogAction = {
  page: any;
  handler: (dialog: any) => Promise<void>;
};

type BrowserUseSettings = {
  enabled: boolean;
};

type RuntimeReadiness = {
  playwright: any | null;
  playwrightInstalled: boolean;
  chromiumInstalled: boolean;
  chromiumExecutablePath: string | null;
  installInProgress: boolean;
  installMessage: string | null;
};

type RuntimeProbe = Omit<RuntimeReadiness, 'installInProgress' | 'installMessage'>;

const sessions = new Map<string, BrowserUseSession>();
const handles = new Map<string, RuntimeHandle>();
const networkCaptures = new Map<string, NetworkCapture>();
const consoleBuffers = new Map<string, BrowserConsoleBuffer>();
const consoleAttachedPages = new WeakSet<object>();
const dialogHandlers = new Map<string, DialogAction>();
const baseUserAgents = new Map<string, string>();
const promptNotificationIds = new Map<string, string>();
let installPromise: Promise<{ success: boolean; message: string }> | null = null;
let lastInstallMessage: string | null = null;
let runtimeProbeCache: { value: RuntimeProbe; updatedAt: number } | null = null;

const DEFAULT_SETTINGS: BrowserUseSettings = {
  enabled: false,
};
const AGENT_OWNER_ID = 'agent';
const PROFILE_ROOT = path.join(os.homedir(), '.cloudcli', 'browser-use', 'profiles');
const MCP_SERVER_NAME = 'cloudcli-browser';
const LEGACY_MCP_SERVER_NAMES = ['cloudcli-browser-use'];
const RUNTIME_READINESS_CACHE_TTL_MS = 30_000;

type DevicePresetName = 'desktop' | 'iphone-13' | 'pixel-7' | 'ipad';

type DevicePreset = {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  userAgent?: string;
};

const DEVICE_PRESETS: Record<DevicePresetName, DevicePreset> = {
  desktop: {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  },
  'iphone-13': {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1',
  },
  'pixel-7': {
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  },
  ipad: {
    width: 820,
    height: 1180,
    deviceScaleFactor: 2,
    mobile: true,
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1',
  },
};

const pendingInputStore = new PendingInputStore({
  unrefTimers: true,
  onCreated: (prompt) => {
    try {
      const notification = systemNotificationsDb.create({
        kind: 'action_required',
        severity: 'warning',
        title: 'Browser input required',
        body: prompt.prompt,
        source: 'browser-use',
        meta: {
          browserPrompt: true,
          promptId: prompt.id,
          sessionId: prompt.sessionId,
          secret: prompt.secret,
          choices: prompt.choices,
        },
      });
      promptNotificationIds.set(prompt.id, notification.notification_id);
    } catch {
      // The in-memory prompt remains usable when the optional notification
      // inbox is unavailable (for example during early server startup).
    }
  },
  onCompleted: (prompt) => {
    const notificationId = promptNotificationIds.get(prompt.id);
    promptNotificationIds.delete(prompt.id);
    if (notificationId) {
      try {
        systemNotificationsDb.dismiss(notificationId);
      } catch {
        // Prompt completion must not be affected by notification cleanup.
      }
    }
  },
});

function getRuntime(): BrowserUseRuntime {
  return IS_PLATFORM ? 'cloud' : 'local';
}

function readSettings(): BrowserUseSettings {
  try {
    const raw = appConfigDb.get(BROWSER_USE_SETTINGS_KEY);
    if (!raw) {
      return DEFAULT_SETTINGS;
    }

    const parsed = JSON.parse(raw) as Partial<BrowserUseSettings>;
    return {
      enabled: parsed.enabled === true,
    };
  } catch (error: any) {
    console.warn('[Browser] Failed to read settings:', error?.message || error);
    return DEFAULT_SETTINGS;
  }
}

function writeSettings(settings: BrowserUseSettings): BrowserUseSettings {
  const normalized = {
    enabled: settings.enabled === true,
  };

  appConfigDb.set(BROWSER_USE_SETTINGS_KEY, JSON.stringify(normalized));
  return normalized;
}

function getOrCreateMcpToken(): string {
  const existing = appConfigDb.get(BROWSER_USE_MCP_TOKEN_KEY);
  if (existing) {
    return existing;
  }
  const token = randomBytes(32).toString('hex');
  appConfigDb.set(BROWSER_USE_MCP_TOKEN_KEY, token);
  return token;
}

function getSetupMessage(settings: BrowserUseSettings, readiness: RuntimeReadiness): string {
  if (!settings.enabled) {
    return 'Browser is disabled in settings.';
  }

  if (!readiness.playwrightInstalled) {
    return 'Install Playwright and Chromium to use browser sessions.';
  }

  if (!readiness.chromiumInstalled) {
    return 'Playwright is installed, but Chromium is missing. Install the Chromium runtime to continue.';
  }

  return readiness.installMessage || 'Browser runtime is not ready.';
}

function getPlaywright(): any | null {
  try {
    return require('playwright');
  } catch {
    return null;
  }
}

function getMcpCommand(): { command: string; args: string[] } {
  const serverDir = path.resolve(__dirname, '..', '..');
  const mcpScriptPath = path.join(serverDir, 'browser-use-mcp.js');
  if (fs.existsSync(mcpScriptPath)) {
    return {
      command: process.execPath,
      args: [mcpScriptPath],
    };
  }

  return {
    command: 'cloudcli',
    args: ['browser-use-mcp'],
  };
}

function getMcpApiUrl(): string {
  const port = process.env.SERVER_PORT || process.env.PORT || '3001';
  return `http://127.0.0.1:${port}/api/browser-use-mcp`;
}

async function removeMcpServerFromAllProviders(name: string) {
  const results = await providerMcpService.removeMcpServerFromAllProviders({
    name,
    scope: 'user',
  });
  return results.map((result) => ({ ...result, name }));
}

function normalizeProfileName(profileName?: string | null): string | null {
  const normalized = String(profileName || '').trim();
  if (!normalized) {
    return null;
  }

  return normalized.slice(0, 80);
}

function getProfilePath(profileName: string): string {
  const safeName = profileName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'default';
  return path.join(PROFILE_ROOT, safeName);
}

function probeRuntime(): RuntimeProbe {
  const playwright = getPlaywright();
  const readiness: RuntimeProbe = {
    playwright,
    playwrightInstalled: Boolean(playwright),
    chromiumInstalled: false,
    chromiumExecutablePath: null,
  };

  if (!playwright) {
    return readiness;
  }

  try {
    const executablePath = playwright.chromium.executablePath();
    readiness.chromiumExecutablePath = executablePath;
    readiness.chromiumInstalled = Boolean(executablePath && fs.existsSync(executablePath));
  } catch {
    readiness.chromiumInstalled = false;
  }

  return readiness;
}

function getRuntimeReadiness(options: { force?: boolean } = {}): RuntimeReadiness {
  const now = Date.now();
  const cachedProbe = runtimeProbeCache;
  const canUseCache = !options.force
    && !installPromise
    && cachedProbe
    && now - cachedProbe.updatedAt < RUNTIME_READINESS_CACHE_TTL_MS;
  const probe = canUseCache ? cachedProbe.value : probeRuntime();

  if (!canUseCache && !installPromise) {
    runtimeProbeCache = { value: probe, updatedAt: now };
  }

  return {
    ...probe,
    installInProgress: Boolean(installPromise),
    installMessage: lastInstallMessage,
  };
}

const INSTALL_COMMAND_TIMEOUT_MS = Number.parseInt(
  process.env.CLOUDCLI_BROWSER_USE_INSTALL_TIMEOUT_MS || String(10 * 60 * 1000),
  10,
);

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output: string[] = [];
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new Error(
        `${command} ${args.join(' ')} timed out after ${INSTALL_COMMAND_TIMEOUT_MS}ms.`,
      )));
    }, INSTALL_COMMAND_TIMEOUT_MS);
    timer.unref?.();

    // stdio config above guarantees the pipes exist; cross-spawn's types
    // just don't narrow them the way node's spawn overloads do.
    child.stdout?.on('data', (chunk) => output.push(String(chunk)));
    child.stderr?.on('data', (chunk) => output.push(String(chunk)));
    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code) => finish(() => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(output.join('').trim() || `${command} ${args.join(' ')} exited with code ${code}`));
    }));
  });
}

function formatInstallError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('sudo') && message.includes('password')) {
    return 'Installing Chromium system dependencies requires administrator privileges. Run `npx playwright install-deps chromium` on the machine where CloudCLI runs, then try again.';
  }
  return message || 'Failed to install Browser runtime.';
}

async function installRuntime(): Promise<{ success: boolean; message: string }> {
  if (installPromise) {
    return installPromise;
  }

  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  runtimeProbeCache = null;
  installPromise = (async () => {
    try {
      lastInstallMessage = 'Installing Playwright package...';
      await runCommand(npmCommand, ['install', '--no-save', '--no-package-lock', 'playwright']);

      if (process.platform === 'linux') {
        lastInstallMessage = 'Installing Chromium system dependencies...';
        await runCommand(npmCommand, ['exec', '--', 'playwright', 'install-deps', 'chromium']);
      }

      lastInstallMessage = 'Installing Chromium runtime...';
      await runCommand(npmCommand, ['exec', '--', 'playwright', 'install', 'chromium']);

      lastInstallMessage = 'Browser runtime installed.';
      return { success: true, message: lastInstallMessage };
    } catch (error) {
      lastInstallMessage = formatInstallError(error);
      return { success: false, message: lastInstallMessage };
    }
  })();

  try {
    return await installPromise;
  } finally {
    installPromise = null;
    runtimeProbeCache = null;
  }
}

function normalizeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error('URL is required.');
  }

  const withProtocol = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const parsed = new URL(withProtocol);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http and https URLs are supported.');
  }

  return parsed.toString();
}

function publicSession(session: BrowserUseSession): PublicBrowserUseSession {
  const { ownerId: _ownerId, ...publicFields } = session;
  return publicFields;
}

function ownerSessions(ownerId: string): BrowserUseSession[] {
  return [...sessions.values()].filter((session) => session.ownerId === ownerId);
}

function getSessionWorkspacePath(sessionId: string): string {
  return path.join(SESSION_WORKSPACE_ROOT, sessionId);
}

function getNetworkCapture(sessionId: string): NetworkCapture {
  const capture = networkCaptures.get(sessionId);
  if (!capture) {
    throw new Error('Network recording is not available for this Browser session.');
  }
  return capture;
}

function getConsoleBuffer(sessionId: string): BrowserConsoleBuffer {
  const buffer = consoleBuffers.get(sessionId);
  if (!buffer) {
    throw new Error('Console buffering is not available for this Browser session.');
  }
  return buffer;
}

function readPageLocation(message: any): { url: string | null; lineNumber: number | null; columnNumber: number | null } {
  try {
    const location = typeof message.location === 'function' ? message.location() : null;
    return {
      url: typeof location?.url === 'string' && location.url ? location.url : null,
      lineNumber: typeof location?.lineNumber === 'number' && location.lineNumber >= 0
        ? location.lineNumber
        : null,
      columnNumber: typeof location?.columnNumber === 'number' && location.columnNumber >= 0
        ? location.columnNumber
        : null,
    };
  } catch {
    return { url: null, lineNumber: null, columnNumber: null };
  }
}

function attachConsoleCaptureToPage(sessionId: string, page: any): void {
  if (!page || typeof page.on !== 'function' || consoleAttachedPages.has(page)) {
    return;
  }
  const buffer = consoleBuffers.get(sessionId);
  if (!buffer) {
    return;
  }
  consoleAttachedPages.add(page);
  page.on('console', (message: any) => {
    const location = readPageLocation(message);
    let text = '';
    try {
      text = typeof message.text === 'function' ? message.text() : String(message);
    } catch {
      text = '[Unable to read console message]';
    }
    const type = typeof message.type === 'function' ? message.type() : 'log';
    buffer.add({
      level: normalizeConsoleLevel(String(type)),
      text,
      ...location,
      stack: null,
    });
  });
  page.on('pageerror', (error: any) => {
    buffer.add({
      level: 'pageerror',
      text: error?.message ? String(error.message) : String(error),
      url: typeof page.url === 'function' ? page.url() : null,
      lineNumber: null,
      columnNumber: null,
      stack: error?.stack ? String(error.stack) : null,
    });
  });
}

function attachConsoleCaptureToPages(sessionId: string, pages: any[]): void {
  for (const page of pages) {
    attachConsoleCaptureToPage(sessionId, page);
  }
}

function publicSessionWithoutScreenshot(session: BrowserUseSession): PublicBrowserUseSession {
  return { ...publicSession(session), screenshotDataUrl: null };
}

function serializeEvaluateResult(value: unknown, maxBytes: number): {
  json: string;
  truncated: boolean;
  sizeBytes: number;
} {
  const requestedLimit = Number.isFinite(maxBytes) ? Math.floor(maxBytes) : 100_000;
  const safeLimit = Math.max(1_024, Math.min(requestedLimit, 1_000_000));
  const seen = new WeakSet<object>();
  let serialized: string;
  try {
    serialized = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'bigint') {
        return `${item.toString()}n`;
      }
      if (item && typeof item === 'object') {
        if (seen.has(item)) {
          return '[Circular]';
        }
        seen.add(item);
      }
      return item;
    }) ?? 'null';
  } catch (error) {
    serialized = JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
  }
  const sizeBytes = Buffer.byteLength(serialized, 'utf8');
  if (sizeBytes <= safeLimit) {
    return { json: serialized, truncated: false, sizeBytes };
  }
  const previewBytes = Math.max(0, safeLimit - 96);
  const preview = Buffer.from(serialized, 'utf8').subarray(0, previewBytes).toString('utf8');
  const json = JSON.stringify({ truncated: true, sizeBytes, preview });
  return { json, truncated: true, sizeBytes };
}

function safeDownloadFileName(rawName: unknown, fallback: string): string {
  const requested = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : fallback;
  const baseName = path.basename(requested).replace(/[^a-zA-Z0-9._-]+/g, '-');
  return baseName || fallback;
}

async function attachNetworkCaptureToPages(sessionId: string, pages: any[]): Promise<void> {
  const capture = networkCaptures.get(sessionId);
  if (!capture) {
    return;
  }
  await Promise.all(pages.map((page) => capture.attachPage(page).catch(() => undefined)));
}

async function closeHandle(sessionId: string): Promise<void> {
  const dialogAction = dialogHandlers.get(sessionId);
  if (dialogAction?.page?.off) {
    dialogAction.page.off('dialog', dialogAction.handler);
  }
  dialogHandlers.delete(sessionId);
  const handle = handles.get(sessionId);
  handles.delete(sessionId);
  const networkCapture = networkCaptures.get(sessionId);
  networkCaptures.delete(sessionId);
  consoleBuffers.delete(sessionId);
  baseUserAgents.delete(sessionId);
  await networkCapture?.dispose().catch(() => undefined);
  await handle?.context?.close?.().catch(() => undefined);
  await handle?.browser?.close().catch(() => undefined);
}

async function expireStaleSessions(now = Date.now()): Promise<void> {
  await Promise.all([...sessions.values()].map(async (session) => {
    if (session.status !== 'ready') {
      return;
    }

    const updatedAt = Date.parse(session.updatedAt);
    if (!Number.isFinite(updatedAt) || now - updatedAt <= SESSION_TTL_MS) {
      return;
    }

    await closeHandle(session.id);
    session.status = 'stopped';
    session.updatedAt = new Date(now).toISOString();
    session.lastAction = 'expire';
    session.message = 'Browser session expired after inactivity.';
  }));
}

async function captureSession(session: BrowserUseSession, page: any): Promise<void> {
  const screenshot = await page.screenshot({ type: 'jpeg', quality: 72, fullPage: false });
  session.screenshotDataUrl = `data:image/jpeg;base64,${Buffer.from(screenshot).toString('base64')}`;
  session.title = await page.title().catch(() => null);
  session.url = page.url() || session.url;
  session.viewport = page.viewportSize?.() || session.viewport;
  session.updatedAt = new Date().toISOString();
}

function networkFilterFromInput(input: Record<string, unknown>): NetworkFilter {
  const rawStatus = input.status ?? input.statusCode;
  const status = Array.isArray(rawStatus)
    ? rawStatus.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    : typeof rawStatus === 'number' && Number.isFinite(rawStatus)
      ? rawStatus
      : typeof rawStatus === 'string' && rawStatus.trim() && Number.isFinite(Number(rawStatus))
        ? Number(rawStatus)
        : undefined;
  const rawSince = input.since ?? input.sinceTimestamp ?? input.since_timestamp;
  const since = typeof rawSince === 'string' || typeof rawSince === 'number'
    ? rawSince
    : undefined;
  return {
    url: typeof (input.url ?? input.urlSubstring ?? input.url_substring) === 'string'
      ? String(input.url ?? input.urlSubstring ?? input.url_substring)
      : undefined,
    urlRegex: typeof (input.urlRegex ?? input.urlPattern ?? input.regex ?? input.url_regex) === 'string'
      ? String(input.urlRegex ?? input.urlPattern ?? input.regex ?? input.url_regex)
      : undefined,
    method: typeof input.method === 'string' ? input.method : undefined,
    status,
    resourceType: typeof (input.resourceType ?? input.resource_type) === 'string'
      ? String(input.resourceType ?? input.resource_type)
      : undefined,
    minDurationMs: typeof (input.minDurationMs ?? input.minDuration ?? input.min_duration_ms) === 'number'
      ? Number(input.minDurationMs ?? input.minDuration ?? input.min_duration_ms)
      : undefined,
    since,
  };
}

function safeHarFileName(rawName: unknown): string {
  const requested = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : 'network.har';
  const baseName = path.basename(requested).replace(/[^a-zA-Z0-9._-]+/g, '-');
  const normalized = baseName || 'network.har';
  return normalized.toLowerCase().endsWith('.har') ? normalized : `${normalized}.har`;
}

function readHarFile(rawPath: unknown): { path: string; requests: ReturnType<typeof parseHar> } {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    throw new Error('harPath is required when analyzing an imported HAR.');
  }
  const requestedPath = path.resolve(SESSION_WORKSPACE_ROOT, rawPath.trim());
  const rootPrefix = SESSION_WORKSPACE_ROOT.endsWith(path.sep) ? SESSION_WORKSPACE_ROOT : `${SESSION_WORKSPACE_ROOT}${path.sep}`;
  if (requestedPath !== SESSION_WORKSPACE_ROOT && !requestedPath.startsWith(rootPrefix)) {
    throw new Error('harPath must point to a file inside the Browser session workspace root.');
  }
  let resolvedPath = requestedPath;
  let raw: string;
  try {
    const realPath = fs.realpathSync(requestedPath);
    if (realPath !== SESSION_WORKSPACE_ROOT && !realPath.startsWith(rootPrefix)) {
      throw new Error('harPath must point to a file inside the Browser session workspace root.');
    }
    resolvedPath = realPath;
    const stat = fs.statSync(realPath);
    if (!stat.isFile()) {
      throw new Error('harPath must point to a regular file.');
    }
    if (stat.size > MAX_HAR_BYTES) {
      throw new Error(`HAR file exceeds the ${MAX_HAR_BYTES} byte limit.`);
    }
    raw = fs.readFileSync(realPath, 'utf8');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('harPath ')) {
      throw error;
    }
    throw new Error('Unable to read HAR file from the Browser session workspace.');
  }
  try {
    return { path: resolvedPath, requests: parseHar(raw) };
  } catch {
    throw new Error('HAR file is not valid HAR 1.2.');
  }
}

async function getActionPoint(page: any, input: { selector?: string; text?: string; x?: number; y?: number }) {
  if (typeof input.x === 'number' && typeof input.y === 'number') {
    return { x: input.x, y: input.y };
  }

  const locator = input.selector
    ? page.locator(input.selector).first()
    : input.text
      ? page.getByText(input.text, { exact: false }).first()
      : null;

  if (!locator) {
    return null;
  }

  const box = await locator.boundingBox().catch(() => null);
  if (!box) {
    return null;
  }

  return {
    x: Math.round(box.x + box.width / 2),
    y: Math.round(box.y + box.height / 2),
  };
}

export const browserUseService = {
  async getSettings() {
    return readSettings();
  },

  async updateSettings(settings: Partial<BrowserUseSettings>) {
    const current = readSettings();
    const nextSettings = {
      enabled: typeof settings.enabled === 'boolean' ? settings.enabled : current.enabled,
    };

    const next = writeSettings(nextSettings);
    if (next.enabled) {
      await this.registerAgentMcp();
    } else if (current.enabled) {
      await this.unregisterAgentMcp();
      await this.stopAllSessions();
    }
    return next;
  },

  async getStatus() {
    const settings = readSettings();
    const readiness = getRuntimeReadiness();
    const available = settings.enabled && readiness.playwrightInstalled && readiness.chromiumInstalled;

    return {
      enabled: settings.enabled,
      runtime: getRuntime(),
      available,
      playwrightInstalled: readiness.playwrightInstalled,
      chromiumInstalled: readiness.chromiumInstalled,
      installInProgress: readiness.installInProgress,
      sessionCount: sessions.size,
      message: available
        ? 'Browser runtime is available.'
        : getSetupMessage(settings, readiness),
    };
  },

  async registerAgentMcp() {
    const { command, args } = getMcpCommand();
    await Promise.all(LEGACY_MCP_SERVER_NAMES.map((name) => removeMcpServerFromAllProviders(name)));
    const results = await providerMcpService.addMcpServerToAllProviders({
      name: MCP_SERVER_NAME,
      scope: 'user',
      transport: 'stdio',
      command,
      args,
      env: {
        CLOUDCLI_BROWSER_USE_MCP_TOKEN: getOrCreateMcpToken(),
        CLOUDCLI_BROWSER_USE_API_URL: getMcpApiUrl(),
      },
    });
    return { name: MCP_SERVER_NAME, command, args, results };
  },

  getMcpToken() {
    return getOrCreateMcpToken();
  },

  async unregisterAgentMcp() {
    const results = (await Promise.all(
      [MCP_SERVER_NAME, ...LEGACY_MCP_SERVER_NAMES].map((name) => removeMcpServerFromAllProviders(name)),
    )).flat();
    return { name: MCP_SERVER_NAME, results };
  },

  async installRuntime() {
    const result = await installRuntime();
    return {
      ...result,
      status: await this.getStatus(),
    };
  },

  async listSessions() {
    await expireStaleSessions();
    return [...sessions.values()]
      .filter((session) => session.ownerId === AGENT_OWNER_ID)
      .map(publicSession);
  },

  async createAgentSession(options?: { profileName?: string | null; recordNetwork?: boolean }) {
    const settings = readSettings();
    if (!settings.enabled) {
      throw new Error('Browser agent tools are disabled.');
    }

    await expireStaleSessions();
    const profileName = normalizeProfileName(options?.profileName);

    const now = new Date().toISOString();
    const sessionId = randomUUID();
    const sessionWorkspacePath = getSessionWorkspacePath(sessionId);
    const session: BrowserUseSession = {
      id: sessionId,
      ownerId: AGENT_OWNER_ID,
      createdBy: 'agent',
      runtime: getRuntime(),
      status: 'unavailable',
      url: null,
      title: null,
      screenshotDataUrl: null,
      createdAt: now,
      updatedAt: now,
      lastAction: 'create',
      message: null,
      profileName,
      viewport: { width: 1440, height: 900 },
      cursor: null,
      workspacePath: sessionWorkspacePath,
      networkRecording: options?.recordNetwork ?? NETWORK_RECORDING_DEFAULT,
    };

    const activeOwnerSessions = ownerSessions(AGENT_OWNER_ID).filter((item) => item.status === 'ready');
    if (activeOwnerSessions.length >= MAX_SESSIONS_PER_OWNER) {
      throw new Error(`Browser is limited to ${MAX_SESSIONS_PER_OWNER} active agent sessions.`);
    }

    fs.mkdirSync(sessionWorkspacePath, { recursive: true });
    networkCaptures.set(session.id, new NetworkCapture(session.id, {
      enabled: session.networkRecording,
    }));
    consoleBuffers.set(session.id, new BrowserConsoleBuffer(CONSOLE_MAX_MESSAGES));

    const readiness = getRuntimeReadiness();
    if (!settings.enabled || !readiness.playwrightInstalled || !readiness.chromiumInstalled || !readiness.playwright) {
      session.message = getSetupMessage(settings, readiness);
      sessions.set(session.id, session);
      return publicSession(session);
    }

    let browser: any | undefined;
    let context: any | undefined;
    let page: any;
    const launchOptions = {
      headless: true,
      args: ['--disable-dev-shm-usage'],
    };
    const contextOptions = {
      viewport: { width: 1440, height: 900 },
      serviceWorkers: 'block',
    };

    if (profileName) {
      fs.mkdirSync(PROFILE_ROOT, { recursive: true });
      context = await readiness.playwright.chromium.launchPersistentContext(getProfilePath(profileName), {
        ...launchOptions,
        ...contextOptions,
      });
      page = context.pages()[0] || await context.newPage();
    } else {
      browser = await readiness.playwright.chromium.launch(launchOptions);
      context = await browser.newContext(contextOptions);
      page = await context.newPage();
    }
    session.status = 'ready';
    session.message = 'Browser session is ready.';
    sessions.set(session.id, session);
    handles.set(session.id, { browser, context, page });
    const baseUserAgent = await page.evaluate('navigator.userAgent').catch(() => '');
    if (typeof baseUserAgent === 'string' && baseUserAgent) {
      baseUserAgents.set(session.id, baseUserAgent);
    }
    const networkCapture = networkCaptures.get(session.id);
    networkCapture?.attachContext(context);
    await attachNetworkCaptureToPages(session.id, context.pages());
    attachConsoleCaptureToPages(session.id, context.pages());
    await captureSession(session, page);
    return publicSession(session);
  },

  async listAgentSessions() {
    const settings = readSettings();
    if (!settings.enabled) {
      return [];
    }
    await expireStaleSessions();
    return [...sessions.values()]
      .filter((session) => session.ownerId === AGENT_OWNER_ID)
      .map(publicSession);
  },

  async getAgentSession(sessionId: string) {
    const settings = readSettings();
    if (!settings.enabled) {
      throw new Error('Browser agent tools are disabled.');
    }
    const session = sessions.get(sessionId);
    if (!session || session.ownerId !== AGENT_OWNER_ID) {
      throw new Error('Browser session not found.');
    }
    return session;
  },

  async agentNavigate(sessionId: string, rawUrl: string) {
    await this.getAgentSession(sessionId);
    await expireStaleSessions();

    const session = sessions.get(sessionId);
    if (!session || session.ownerId !== AGENT_OWNER_ID) {
      throw new Error('Browser session not found.');
    }

    if (session.status !== 'ready') {
      throw new Error(session.message || 'Browser session is not available.');
    }

    const handle = handles.get(sessionId);
    if (!handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }

    const url = normalizeUrl(rawUrl);
    await handle.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    session.lastAction = `navigate:${url}`;
    session.cursor = null;
    await captureSession(session, handle.page);
    return publicSession(session);
  },

  async agentSnapshot(sessionId: string) {
    const session = await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }
    await captureSession(session, handle.page);
    const text = await handle.page.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
    return {
      session: publicSession(session),
      text: text.slice(0, 30_000),
    };
  },

  /**
   * Full-quality PNG of the current page. `agentSnapshot` returns a 72%-quality
   * JPEG sized for the live preview pane; publishing needs the lossless frame.
   */
  async agentCapturePng(
    sessionId: string,
    input: { fullPage?: boolean; waitMs?: number } = {},
  ): Promise<Buffer> {
    await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }
    // Let fonts settle and entry animations finish before the shutter.
    await handle.page.waitForTimeout(Math.min(Math.max(input.waitMs ?? 600, 0), 10_000));
    const buffer = await handle.page.screenshot({
      type: 'png',
      fullPage: input.fullPage === true,
    });
    return Buffer.from(buffer);
  },

  async agentClick(sessionId: string, input: { selector?: string; text?: string; x?: number; y?: number }) {
    const session = await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }
    const point = await getActionPoint(handle.page, input);

    if (input.selector) {
      await handle.page.locator(input.selector).first().click({ timeout: 10_000 });
    } else if (input.text) {
      await handle.page.getByText(input.text, { exact: false }).first().click({ timeout: 10_000 });
    } else if (typeof input.x === 'number' && typeof input.y === 'number') {
      await handle.page.mouse.click(input.x, input.y);
    } else {
      throw new Error('Provide selector, text, or x/y coordinates.');
    }

    session.lastAction = 'click';
    session.cursor = point ? { ...point, actor: 'agent' } : null;
    await captureSession(session, handle.page);
    return publicSession(session);
  },

  async agentType(sessionId: string, input: { selector?: string; text: string; submit?: boolean }) {
    const session = await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }

    if (input.selector) {
      await handle.page.locator(input.selector).first().fill(input.text, { timeout: 10_000 });
      session.cursor = await getActionPoint(handle.page, input).then((point) => (
        point ? { ...point, actor: 'agent' as const } : null
      ));
    } else {
      await handle.page.keyboard.type(input.text);
    }
    if (input.submit) {
      await handle.page.keyboard.press('Enter');
    }

    session.lastAction = 'type';
    await captureSession(session, handle.page);
    return publicSession(session);
  },

  async agentTypeSecret(sessionId: string, input: { selector?: string; secretHandle: string; submit?: boolean }) {
    const session = await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }
    const secretValue = pendingInputStore.consumeSecretHandle(input.secretHandle);
    if (secretValue === null) {
      throw new Error('Secret handle is missing, expired, or already consumed.');
    }

    if (input.selector) {
      await handle.page.locator(input.selector).first().fill(secretValue, { timeout: 10_000 });
      session.cursor = await getActionPoint(handle.page, { selector: input.selector }).then((point) => (
        point ? { ...point, actor: 'agent' as const } : null
      ));
    } else {
      await handle.page.keyboard.type(secretValue);
    }
    if (input.submit) {
      await handle.page.keyboard.press('Enter');
    }

    // Do not take a screenshot after typing a secret: a screenshot would make
    // the value visible in the tool result. The next ordinary browser action
    // can refresh the live preview once the secret has been submitted.
    session.lastAction = 'type_secret';
    session.updatedAt = new Date().toISOString();
    return {
      session: publicSessionWithoutScreenshot(session),
      secretTyped: true,
    };
  },

  async agentEvaluate(sessionId: string, input: { expression: string; maxBytes?: number }) {
    const session = await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }
    const expression = typeof input.expression === 'string' ? input.expression.trim() : '';
    if (!expression) {
      throw new Error('expression is required.');
    }
    const value = await handle.page.evaluate(expression);
    const serialized = serializeEvaluateResult(value, input.maxBytes ?? 100_000);
    session.lastAction = 'evaluate';
    await captureSession(session, handle.page);
    return {
      sessionId: session.id,
      ...serialized,
    };
  },

  async agentConsoleMessages(sessionId: string, input: { level?: BrowserConsoleLevel; clear?: boolean } = {}) {
    const session = await this.getAgentSession(sessionId);
    const buffer = getConsoleBuffer(session.id);
    const messages = buffer.read({ level: input.level, clear: input.clear === true });
    return {
      sessionId: session.id,
      messages,
      count: messages.length,
      bufferSize: buffer.size,
      cleared: input.clear === true,
    };
  },

  async agentFillForm(sessionId: string, fields: Array<{ selector: string; value: string }>) {
    const session = await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }
    for (const field of fields) {
      await handle.page.locator(field.selector).first().fill(field.value, { timeout: 10_000 });
    }
    session.lastAction = 'fill_form';
    if (fields[0]) {
      session.cursor = await getActionPoint(handle.page, { selector: fields[0].selector }).then((point) => (
        point ? { ...point, actor: 'agent' as const } : null
      ));
    }
    await captureSession(session, handle.page);
    return publicSession(session);
  },

  async agentPressKey(sessionId: string, key: string) {
    const session = await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }
    await handle.page.keyboard.press(key);
    session.lastAction = `press_key:${key}`;
    await captureSession(session, handle.page);
    return publicSession(session);
  },

  async agentSelectOption(sessionId: string, selector: string, values: string[]) {
    const session = await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }
    await handle.page.locator(selector).first().selectOption(values, { timeout: 10_000 });
    session.lastAction = 'select_option';
    session.cursor = await getActionPoint(handle.page, { selector }).then((point) => (
      point ? { ...point, actor: 'agent' as const } : null
    ));
    await captureSession(session, handle.page);
    return publicSession(session);
  },

  async agentWaitFor(sessionId: string, input: { text?: string; url?: string; timeoutMs?: number }) {
    const session = await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }
    const timeout = Math.max(250, Math.min(input.timeoutMs || 5_000, 30_000));
    if (input.text) {
      await handle.page.getByText(input.text, { exact: false }).first().waitFor({ timeout });
    } else if (input.url) {
      await handle.page.waitForURL(input.url, { timeout });
    } else {
      await handle.page.waitForTimeout(timeout);
    }
    session.lastAction = 'wait_for';
    await captureSession(session, handle.page);
    return publicSession(session);
  },

  async agentTabs(sessionId: string, input: { action?: 'list' | 'new' | 'select' | 'close'; index?: number; url?: string }) {
    const session = await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.context || !handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }
    const action = input.action || 'list';
    if (action === 'new') {
      const page = await handle.context.newPage();
      handles.set(sessionId, { ...handle, page });
      await attachNetworkCaptureToPages(sessionId, [page]);
      attachConsoleCaptureToPages(sessionId, [page]);
      if (input.url) {
        await this.agentNavigate(sessionId, input.url);
      }
    } else if (action === 'select') {
      const page = handle.context.pages()[input.index || 0];
      if (!page) {
        throw new Error('Tab not found.');
      }
      handles.set(sessionId, { ...handle, page });
    } else if (action === 'close') {
      const pages = handle.context.pages();
      const page = pages[input.index ?? pages.indexOf(handle.page)];
      if (!page) {
        throw new Error('Tab not found.');
      }
      await page.close();
      const nextPage = handle.context.pages()[0] || await handle.context.newPage();
      handles.set(sessionId, { ...handle, page: nextPage });
      attachConsoleCaptureToPage(sessionId, nextPage);
    }
    const updatedHandle = handles.get(sessionId);
    await attachNetworkCaptureToPages(sessionId, handle.context.pages());
    attachConsoleCaptureToPages(sessionId, handle.context.pages());
    await captureSession(session, updatedHandle?.page || handle.page);
    return {
      session: publicSession(session),
      tabs: handle.context.pages().map((page: any, index: number) => ({
        index,
        url: page.url(),
        active: page === (updatedHandle?.page || handle.page),
      })),
    };
  },

  async agentNavigateHistory(sessionId: string, action: 'back' | 'forward' | 'reload') {
    const session = await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }
    const options = { waitUntil: 'domcontentloaded' as const, timeout: 30_000 };
    if (action === 'back') {
      await handle.page.goBack(options).catch((error: unknown) => {
        if (!(error instanceof Error) || !/wait|navigation/i.test(error.message)) {
          throw error;
        }
      });
    } else if (action === 'forward') {
      await handle.page.goForward(options).catch((error: unknown) => {
        if (!(error instanceof Error) || !/wait|navigation/i.test(error.message)) {
          throw error;
        }
      });
    } else {
      await handle.page.reload(options);
    }
    session.lastAction = `navigate_history:${action}`;
    await captureSession(session, handle.page);
    return publicSession(session);
  },

  async agentHandleDialog(sessionId: string, input: { action: 'accept' | 'dismiss'; promptText?: string }) {
    const session = await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.page || typeof handle.page.on !== 'function') {
      throw new Error('Browser runtime handle is not available.');
    }
    const previous = dialogHandlers.get(sessionId);
    if (previous?.page?.off) {
      previous.page.off('dialog', previous.handler);
    }

    let handler: (dialog: any) => Promise<void>;
    handler = async (dialog: any) => {
      try {
        if (input.action === 'accept') {
          const promptText = typeof input.promptText === 'string' ? input.promptText : undefined;
          await dialog.accept(promptText);
        } else {
          await dialog.dismiss();
        }
      } catch {
        // Dialogs can disappear when navigation closes their page. The next
        // browser action can install another handler when needed.
      } finally {
        // Detach after firing: the handler is one-shot by contract, and leaving
        // it attached would keep auto-answering later dialogs (and stack with
        // the handler installed by the next browser_handle_dialog call).
        handle.page.off?.('dialog', handler);
        if (dialogHandlers.get(sessionId)?.handler === handler) {
          dialogHandlers.delete(sessionId);
        }
      }
    };
    dialogHandlers.set(sessionId, { page: handle.page, handler });
    handle.page.on('dialog', handler);
    session.lastAction = `handle_dialog:${input.action}`;
    session.updatedAt = new Date().toISOString();
    return { sessionId: session.id, action: input.action, pending: true };
  },

  async agentSetViewport(sessionId: string, input: { width: number; height: number }) {
    const session = await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.page || !handle.context) {
      throw new Error('Browser runtime handle is not available.');
    }
    if (!Number.isFinite(input.width) || !Number.isFinite(input.height) || input.width <= 0 || input.height <= 0) {
      throw new Error('width and height must be positive numbers.');
    }
    const width = Math.max(320, Math.min(Math.floor(input.width), 3_840));
    const height = Math.max(240, Math.min(Math.floor(input.height), 2_160));
    if (typeof handle.context.setViewportSize === 'function') {
      await handle.context.setViewportSize({ width, height });
    } else if (typeof handle.page.setViewportSize === 'function') {
      await handle.page.setViewportSize({ width, height });
    } else {
      throw new Error('This Browser driver does not support viewport changes.');
    }
    session.viewport = { width, height };
    session.lastAction = 'set_viewport';
    await captureSession(session, handle.page);
    return publicSession(session);
  },

  async agentEmulateDevice(sessionId: string, presetName: DevicePresetName) {
    const session = await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    const preset = DEVICE_PRESETS[presetName];
    if (!preset) {
      throw new Error('preset must be desktop, iphone-13, pixel-7, or ipad.');
    }
    if (!handle?.page || !handle.context) {
      throw new Error('Browser runtime handle is not available.');
    }

    if (typeof handle.context.setViewportSize === 'function') {
      await handle.context.setViewportSize({ width: preset.width, height: preset.height });
    } else if (typeof handle.page.setViewportSize === 'function') {
      await handle.page.setViewportSize({ width: preset.width, height: preset.height });
    }

    let cdpSupported = false;
    if (typeof handle.context.newCDPSession === 'function') {
      try {
        const cdp = await handle.context.newCDPSession(handle.page) as {
          send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
          detach?: () => Promise<void>;
        };
        const baseUserAgent = baseUserAgents.get(session.id)
          || (await handle.page.evaluate('navigator.userAgent').catch(() => '')) as string
          || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: preset.width,
          height: preset.height,
          deviceScaleFactor: preset.deviceScaleFactor,
          mobile: preset.mobile,
          screenWidth: preset.width,
          screenHeight: preset.height,
        });
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: preset.mobile });
        await cdp.send('Network.setUserAgentOverride', {
          userAgent: preset.userAgent || baseUserAgent,
        });
        await cdp.detach?.();
        cdpSupported = true;
      } catch {
        // Chromium/CDP is optional; viewport emulation below still works for
        // drivers that expose only setViewportSize.
      }
    }
    session.viewport = { width: preset.width, height: preset.height };
    session.lastAction = `emulate_device:${presetName}`;
    await captureSession(session, handle.page);
    return {
      session: publicSession(session),
      preset: presetName,
      supported: true,
      cdp: cdpSupported,
    };
  },

  async agentDownload(sessionId: string, input: {
    url?: string;
    selector?: string;
    text?: string;
    fileName?: string;
    timeoutMs?: number;
  }) {
    const session = await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }
    const timeout = Math.max(250, Math.min(input.timeoutMs || 30_000, 60_000));
    const downloadPromise = handle.page.waitForEvent('download', { timeout });
    if (input.selector) {
      await Promise.all([
        downloadPromise,
        handle.page.locator(input.selector).first().click({ timeout }),
      ]);
    } else if (input.text) {
      await Promise.all([
        downloadPromise,
        handle.page.getByText(input.text, { exact: false }).first().click({ timeout }),
      ]);
    } else if (input.url) {
      await Promise.all([
        downloadPromise,
        handle.page.goto(normalizeUrl(input.url), { waitUntil: 'domcontentloaded', timeout }),
      ]);
    } else {
      throw new Error('Provide url, selector, or text to start a download.');
    }
    const download = await downloadPromise;
    const suggestedName = typeof download.suggestedFilename === 'function'
      ? download.suggestedFilename()
      : 'download';
    const fileName = safeDownloadFileName(input.fileName, safeDownloadFileName(suggestedName, 'download'));
    fs.mkdirSync(session.workspacePath, { recursive: true });
    const outputPath = path.join(session.workspacePath, fileName);
    await download.saveAs(outputPath);
    const stat = fs.statSync(outputPath);
    session.lastAction = 'download';
    await captureSession(session, handle.page);
    return {
      session: publicSession(session),
      path: outputPath,
      filePath: outputPath,
      fileName,
      suggestedFileName: suggestedName,
      sizeBytes: stat.size,
    };
  },

  async agentUploadFile(sessionId: string, input: { selector: string; filePath: string }) {
    const session = await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }
    const selector = typeof input.selector === 'string' ? input.selector.trim() : '';
    const filePath = typeof input.filePath === 'string' ? path.resolve(input.filePath.trim()) : '';
    if (!selector || !filePath) {
      throw new Error('selector and filePath are required.');
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch (error) {
      throw new Error(`Upload file is not readable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!stat.isFile()) {
      throw new Error('filePath must point to a file.');
    }
    await handle.page.locator(selector).first().setInputFiles(filePath, { timeout: 10_000 });
    session.lastAction = 'upload_file';
    await captureSession(session, handle.page);
    return {
      session: publicSession(session),
      filePath,
      fileName: path.basename(filePath),
      sizeBytes: stat.size,
    };
  },

  async agentAskHuman(input: CreateBrowserHumanPromptInput) {
    if (input.sessionId) {
      const session = await this.getAgentSession(input.sessionId);
      session.lastAction = 'ask_human';
      session.updatedAt = new Date().toISOString();
    }
    const pending = pendingInputStore.create(input);
    return pending.result;
  },

  listPendingPrompts(sessionId?: string) {
    return pendingInputStore.list(sessionId);
  },

  answerPrompt(promptId: string, value: string) {
    const result = pendingInputStore.answer(promptId, value);
    if (!result) {
      throw new Error('Browser prompt was not found or has already timed out.');
    }
    return result;
  },

  async agentNetworkRequests(sessionId: string, input: Record<string, unknown> = {}) {
    const session = await this.getAgentSession(sessionId);
    const capture = getNetworkCapture(session.id);
    const filtered = filterNetworkRequests(capture.getEntries(), networkFilterFromInput(input));
    const requestedLimit = typeof input.limit === 'number' && Number.isFinite(input.limit)
      ? input.limit
      : typeof input.pageSize === 'number' && Number.isFinite(input.pageSize)
        ? input.pageSize
        : 50;
    const limit = Math.max(1, Math.min(500, Math.floor(requestedLimit)));
    const requestedPage = typeof input.page === 'number' && Number.isFinite(input.page) ? input.page : 1;
    const offset = typeof input.offset === 'number' && Number.isFinite(input.offset)
      ? Math.max(0, Math.floor(input.offset))
      : Math.max(0, Math.floor(requestedPage - 1) * limit);
    const page = filtered.slice(offset, offset + limit);
    return {
      sessionId: session.id,
      recording: capture.recordingEnabled,
      requests: page.map(summarizeNetworkRequest),
      total: filtered.length,
      offset,
      limit,
      hasMore: offset + page.length < filtered.length,
      nextOffset: offset + page.length < filtered.length ? offset + page.length : null,
      buffer: capture.stats,
    };
  },

  async agentNetworkGetRequest(
    sessionId: string,
    requestId: string,
    input: { includeSensitive?: boolean; include_sensitive?: boolean; maxBodyBytes?: number } = {},
  ) {
    const session = await this.getAgentSession(sessionId);
    const capture = getNetworkCapture(session.id);
    const request = capture.getEntries().find((entry) => entry.id === requestId);
    if (!request) {
      throw new Error(`Network request "${requestId}" was not found in the session buffer.`);
    }
    return serializeNetworkRequest(request, {
      includeSensitive: input.includeSensitive === true || input.include_sensitive === true,
      maxBodyBytes: input.maxBodyBytes,
    });
  },

  async agentNetworkExportHar(sessionId: string, input: Record<string, unknown> = {}) {
    const session = await this.getAgentSession(sessionId);
    const capture = getNetworkCapture(session.id);
    const requests = filterNetworkRequests(capture.getEntries(), networkFilterFromInput(input));
    const includeSensitive = input.includeSensitive === true || input.include_sensitive === true;
    const har = assembleHar(requests, { includeSensitive });
    const fileName = safeHarFileName(input.fileName ?? input.outputFileName);
    fs.mkdirSync(session.workspacePath, { recursive: true });
    const outputPath = path.join(session.workspacePath, fileName);
    fs.writeFileSync(outputPath, JSON.stringify(har, null, 2), 'utf8');
    const analysis = analyzeNetworkRequests(requests, { topN: 1 });
    return {
      path: outputPath,
      filePath: outputPath,
      entries: requests.length,
      totalRequests: requests.length,
      totalBytes: analysis.totalBytes,
      failedRequests: analysis.failedCount,
      failedCount: analysis.failedCount,
      sensitiveHeadersIncluded: includeSensitive,
      bodyBytesCaptured: capture.stats.bodyBytes,
    };
  },

  async agentNetworkAnalyze(sessionId: string | undefined, input: Record<string, unknown> = {}) {
    const imported = input.harPath ?? input.filePath;
    let requests: ReturnType<typeof parseHar>;
    let source: 'capture' | 'har' = 'capture';
    let sourcePath: string | undefined;
    if (typeof imported === 'string' && imported.trim()) {
      const har = readHarFile(imported);
      requests = har.requests;
      source = 'har';
      sourcePath = har.path;
    } else {
      if (!sessionId) {
        throw new Error('sessionId is required when analyzing the current Browser capture.');
      }
      const session = await this.getAgentSession(sessionId);
      requests = getNetworkCapture(session.id).getEntries();
    }
    const rawTopN = input.topN ?? input.top_n;
    const topN = typeof rawTopN === 'number' && Number.isFinite(rawTopN) ? rawTopN : 10;
    return {
      source,
      ...(sourcePath ? { harPath: sourcePath } : {}),
      ...analyzeNetworkRequests(requests, {
        topN,
        filter: networkFilterFromInput(input),
      }),
    };
  },

  async agentNetworkClear(sessionId: string) {
    const session = await this.getAgentSession(sessionId);
    const capture = getNetworkCapture(session.id);
    return {
      sessionId: session.id,
      ...capture.clear(),
      buffer: capture.stats,
    };
  },

  async agentNetworkThrottle(sessionId: string, preset: 'offline' | 'slow-3g' | 'fast-3g' | 'none') {
    const session = await this.getAgentSession(sessionId);
    return {
      sessionId: session.id,
      ...(await getNetworkCapture(session.id).throttle(preset)),
    };
  },

  async stopSession(sessionId: string) {
    const session = sessions.get(sessionId);
    if (!session || session.ownerId !== AGENT_OWNER_ID) {
      return { stopped: false };
    }

    await closeHandle(sessionId);

    session.status = 'stopped';
    session.updatedAt = new Date().toISOString();
    session.lastAction = 'stop';
    session.message = 'Browser session stopped. Create a new session to continue browsing.';
    return { stopped: true, session: publicSession(session) };
  },

  async deleteSession(sessionId: string) {
    const session = sessions.get(sessionId);
    if (!session || session.ownerId !== AGENT_OWNER_ID) {
      return { deleted: false };
    }

    await closeHandle(sessionId);
    sessions.delete(sessionId);
    return { deleted: true, sessionId };
  },

  async agentStopSession(sessionId: string) {
    await this.getAgentSession(sessionId);
    return this.stopSession(sessionId);
  },

  async stopAllSessions() {
    await Promise.all([...sessions.keys()].map(async (sessionId) => {
      await closeHandle(sessionId);
      const session = sessions.get(sessionId);
      if (session) {
        session.status = 'stopped';
        session.updatedAt = new Date().toISOString();
        session.lastAction = 'shutdown';
        session.message = 'Browser session stopped during server shutdown.';
      }
    }));
  },
};

process.once('beforeExit', () => {
  void browserUseService.stopAllSessions();
});
