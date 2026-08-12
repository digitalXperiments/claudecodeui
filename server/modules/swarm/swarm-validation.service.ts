/**
 * Pre-PR stability gate for Agent Swarm.
 *
 * Runs in the pipeline AFTER the orchestrator handoff and BEFORE
 * finalizeSwarmPullRequest:
 *
 * 1. Static checks — the worktree's own package.json scripts (lint,
 *    typecheck, build, test): run what exists, record skips for the rest,
 *    with bounded output and TERM→KILL subprocess discipline.
 * 2. Functional smoke — boot the app via the project's dev script
 *    (dev:isolated preferred) on dynamically-found free ports with an
 *    isolated DB under the worktree's tmp/cloudcli/, wait for HTTP readiness,
 *    then screenshot the orchestrator's verificationTargets via Playwright.
 * 3. Report — an HTML report (goal, roster, checks, permission-broker
 *    decisions, screenshots) printed to PDF, stored under the PRIMARY
 *    project's tmp/cloudcli/swarm-reports/<swarmId>/ so it survives worktree
 *    cleanup.
 *
 * Gate semantics: any FAILED check blocks the PR. Missing tooling (no
 * Playwright on the host) degrades the gate — static checks still run, smoke
 * and PDF are skipped with loud "degraded" markers — but does not fail it.
 * Non-git/sandbox workspaces run static checks and skip smoke gracefully.
 *
 * All heavy effects sit behind injectable seams (command runner, app booter,
 * browser factory) so tests never launch real dev servers or browsers.
 */

import { createServer } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import spawn from 'cross-spawn';

import { redactSwarmText } from '@/modules/swarm/swarm.repository.js';
import type {
  SwarmAgentSpec,
  SwarmMessage,
  SwarmValidationAttemptRecord,
} from '@/modules/swarm/swarm.types.js';

// Cold monorepo installs, turbo cache misses and Next.js first compiles run
// well past a couple of minutes; a tight budget here reads as a code failure
// when it is really a tooling budget failure.
const DEFAULT_CMD_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_BOOT_TIMEOUT_MS = 4 * 60 * 1000;
const DEFAULT_PAGE_TIMEOUT_MS = 15 * 1000;
const MAX_CAPTURED_OUTPUT = 1024 * 1024;
const REPORT_OUTPUT_CHARS = 8_000;

function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export function validationCommandTimeoutMs(): number {
  return envMs('CLOUDCLI_SWARM_VALIDATION_CMD_TIMEOUT_MS', DEFAULT_CMD_TIMEOUT_MS);
}

export function validationBootTimeoutMs(): number {
  return envMs('CLOUDCLI_SWARM_VALIDATION_BOOT_TIMEOUT_MS', DEFAULT_BOOT_TIMEOUT_MS);
}

function validationPageTimeoutMs(): number {
  return envMs('CLOUDCLI_SWARM_VALIDATION_PAGE_TIMEOUT_MS', DEFAULT_PAGE_TIMEOUT_MS);
}

// ————————————————————————————————————————————————————————————————————————
// Types
// ————————————————————————————————————————————————————————————————————————

export type SwarmValidationCheckStatus = 'passed' | 'failed' | 'skipped' | 'degraded';

export type SwarmValidationCheck = {
  id: string;
  kind: 'static' | 'smoke' | 'report';
  label: string;
  command?: string | null;
  status: SwarmValidationCheckStatus;
  /** Why a check was skipped/degraded/failed (short, human-readable). */
  reason?: string | null;
  /** Trimmed combined stdout/stderr. */
  output: string;
  durationMs: number;
};

export type SwarmValidationGateResult = {
  /** Gate verdict: no check FAILED (skips/degradations do not fail the gate). */
  passed: boolean;
  /** True when smoke/PDF tooling was unavailable and recorded as degraded. */
  degraded: boolean;
  checks: SwarmValidationCheck[];
  screenshots: Array<{ target: string; path: string }>;
  reportDir: string;
  htmlPath: string | null;
  pdfPath: string | null;
  summary: string;
  generatedAt: string;
};

export type SwarmValidationGateInput = {
  swarmId: string;
  goal: string;
  roster: SwarmAgentSpec[];
  /** The swarm worktree (checks/smoke run here). */
  workspaceRoot: string;
  /** The primary checkout (report artifacts stored here; survives worktree cleanup). */
  primaryProjectPath: string;
  blackboard: SwarmMessage[];
  /** Routes/screens the orchestrator flagged; falls back to ['/']. */
  verificationTargets?: string[] | null;
  /** False for sandbox/non-git workspaces: static checks only, smoke skipped. */
  smokeEligible: boolean;
  /** Remediation loop: 1-based attempt number this gate run represents. */
  attempt?: number;
  /** Remediation loop: prior attempts, rendered into the report history. */
  attemptHistory?: SwarmValidationAttemptRecord[] | null;
};

// ————————————————————————————————————————————————————————————————————————
// Seams (injectable for tests; defaults are the real implementations)
// ————————————————————————————————————————————————————————————————————————

export type SwarmValidationCommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
};

export type SwarmValidationCommandRunner = (input: {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
}) => Promise<SwarmValidationCommandResult>;

export type SwarmValidationBrowser = {
  /** Navigate to a URL and return a PNG screenshot. */
  capture(url: string): Promise<Buffer>;
  /** Render a local HTML file (file:// URL) to PDF bytes. */
  renderPdf(htmlFileUrl: string): Promise<Buffer>;
  close(): Promise<void>;
};

/** Returns null when the browser runtime (Playwright/Chromium) is unavailable. */
export type SwarmValidationBrowserFactory = () => Promise<SwarmValidationBrowser | null>;

export type SwarmValidationBootedApp = {
  baseUrl: string;
  stop(): Promise<void>;
  log: string;
};

export type SwarmValidationAppBooter = (input: {
  cwd: string;
  script: string;
  timeoutMs: number;
  /** Isolated scratch area inside the worktree (DB path etc.). */
  workspaceTmpDir: string;
}) => Promise<{ ok: true; app: SwarmValidationBootedApp } | { ok: false; error: string; log?: string }>;

let commandRunnerOverride: SwarmValidationCommandRunner | null = null;
let browserFactoryOverride: SwarmValidationBrowserFactory | null = null;
let appBooterOverride: SwarmValidationAppBooter | null = null;

export function configureSwarmValidationCommandRunner(runner: SwarmValidationCommandRunner | null): void {
  commandRunnerOverride = runner;
}

export function configureSwarmValidationBrowser(factory: SwarmValidationBrowserFactory | null): void {
  browserFactoryOverride = factory;
}

export function configureSwarmValidationAppBooter(booter: SwarmValidationAppBooter | null): void {
  appBooterOverride = booter;
}

// ————————————————————————————————————————————————————————————————————————
// Default command runner (same TERM→KILL discipline as the rest of the module)
// ————————————————————————————————————————————————————————————————————————

const defaultCommandRunner: SwarmValidationCommandRunner = ({ command, args, cwd, env, timeoutMs }) =>
  new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: {
          ...process.env,
          CI: '1',
          NO_COLOR: '1',
          FORCE_COLOR: '0',
          GIT_TERMINAL_PROMPT: '0',
          ...env,
        },
      });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: error instanceof Error ? error.message : String(error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    const finish = (code: number | null, forcedError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        code,
        stdout,
        stderr: forcedError ? `${stderr}\n${forcedError}`.trim() : stderr,
        timedOut,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* optional */
      }
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* optional */ }
        finish(null, `${command} ${args.join(' ')} exceeded ${timeoutMs}ms and was killed`);
      }, 5_000);
      killTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (stdout.length < MAX_CAPTURED_OUTPUT) stdout += String(chunk).slice(0, MAX_CAPTURED_OUTPUT - stdout.length);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (stderr.length < MAX_CAPTURED_OUTPUT) stderr += String(chunk).slice(0, MAX_CAPTURED_OUTPUT - stderr.length);
    });
    child.on('error', (error: Error) => finish(null, error.message));
    child.on('close', (code: number | null) => finish(code));
  });

// ————————————————————————————————————————————————————————————————————————
// Default browser factory (mirrors browser-use.service.ts getPlaywright: the
// dependency is optional on the host; absence degrades the gate, never fails it)
// ————————————————————————————————————————————————————————————————————————

const defaultBrowserFactory: SwarmValidationBrowserFactory = async () => {
  let playwright: { chromium: { launch(opts: { headless: boolean }): Promise<any> } };
  try {
    playwright = (await import('playwright')) as unknown as typeof playwright;
  } catch {
    return null;
  }
  let browser: any;
  try {
    browser = await playwright.chromium.launch({ headless: true });
  } catch {
    return null;
  }
  const pageTimeout = validationPageTimeoutMs();
  return {
    async capture(url: string): Promise<Buffer> {
      const page = await browser.newPage();
      const consoleErrors: string[] = [];
      const onConsole = (message: any) => {
        if (message?.type?.() === 'error') consoleErrors.push(String(message.text?.() ?? 'console error'));
      };
      const onPageError = (error: Error) => consoleErrors.push(error.message);
      page.on?.('console', onConsole);
      page.on?.('pageerror', onPageError);
      try {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: pageTimeout });
        const status = typeof response?.status === 'function' ? response.status() : 200;
        if (status >= 400) throw new Error(`HTTP ${status} while visiting ${url}`);
        // Give client-side apps a moment to paint before the screenshot.
        await page.waitForTimeout(750);
        if (consoleErrors.length > 0) {
          throw new Error(`Browser console error while visiting ${url}: ${consoleErrors.slice(0, 3).join('; ')}`);
        }
        return (await page.screenshot({ fullPage: true, type: 'png' })) as Buffer;
      } finally {
        await page.close().catch(() => undefined);
      }
    },
    async renderPdf(htmlFileUrl: string): Promise<Buffer> {
      const page = await browser.newPage();
      try {
        await page.goto(htmlFileUrl, { waitUntil: 'load', timeout: pageTimeout });
        return (await page.pdf({ format: 'A4', printBackground: true })) as Buffer;
      } finally {
        await page.close().catch(() => undefined);
      }
    },
    async close(): Promise<void> {
      await browser.close().catch(() => undefined);
    },
  };
};

// ————————————————————————————————————————————————————————————————————————
// Default app booter: dev script on free ports with an isolated database
// ————————————————————————————————————————————————————————————————————————

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Ports the dev server ANNOUNCED on stdout. Monorepo tooling (turbo, nx,
 * Next.js, Vite workspaces) ignores injected PORT/VITE_PORT and binds whatever
 * each package's own script hardcodes, so probing only our injected ports made
 * a perfectly healthy app ("Ready in 1519ms") fail the gate as "did not answer
 * HTTP". Anything the log advertises is probed too.
 */
export function announcedPorts(log: string): number[] {
  const ports = new Set<number>();
  const patterns = [
    // "Local: http://localhost:3000", "- Network: http://192.168.1.5:3020"
    /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?|\d+\.\d+\.\d+\.\d+):(\d{2,5})/gi,
    // "listening on port 4000", "server started on port 8080"
    /\b(?:listening|running|started|available|ready|serving)\b[^\n]{0,40}?\bport\s+(\d{2,5})/gi,
    // "next dev -p 3020", "vite --port 5173"
    /(?:^|\s)(?:-p|--port)[=\s]+(\d{2,5})\b/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(log)) !== null) {
      const port = Number(match[1]);
      if (Number.isInteger(port) && port > 0 && port < 65_536) ports.add(port);
    }
  }
  return [...ports];
}

async function probeHttp(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return response.status > 0;
  } catch {
    return false;
  }
}

export const defaultSwarmValidationAppBooter: SwarmValidationAppBooter = async ({ cwd, script, timeoutMs, workspaceTmpDir }) => {
  const serverPort = await findFreePort();
  const vitePort = await findFreePort();
  await mkdir(workspaceTmpDir, { recursive: true });
  const env = {
    ...process.env,
    CI: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    GIT_TERMINAL_PROMPT: '0',
    BROWSER: 'none',
    DATABASE_PATH: path.join(workspaceTmpDir, 'validation.db'),
    SERVER_PORT: String(serverPort),
    PORT: String(serverPort),
    VITE_PORT: String(vitePort),
  };

  let child;
  try {
    // Own process group: dev scripts fan out into task runners and per-package
    // servers, and SIGTERM to the npm wrapper alone leaves those children
    // holding ports for the next attempt.
    child = spawn('npm', ['run', script], { cwd, env, detached: true });
  } catch (error) {
    return { ok: false, error: `Failed to spawn "npm run ${script}": ${error instanceof Error ? error.message : String(error)}` };
  }

  let log = '';
  let exited = false;
  let exitCode: number | null = null;
  const append = (chunk: Buffer | string) => {
    if (log.length < MAX_CAPTURED_OUTPUT) log += String(chunk).slice(0, MAX_CAPTURED_OUTPUT - log.length);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  child.on('close', (code: number | null) => {
    exited = true;
    exitCode = code;
  });

  const signalTree = (signal: NodeJS.Signals): void => {
    // Negative pid targets the whole group; fall back to the direct child when
    // the platform or spawn refused the group.
    try {
      if (typeof child.pid === 'number') process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      try { child.kill(signal); } catch { /* optional */ }
    }
  };

  const stop = async (): Promise<void> => {
    if (exited) return;
    signalTree('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    if (!exited) signalTree('SIGKILL');
  };

  const deadline = Date.now() + timeoutMs;
  const injectedCandidates = [
    `http://127.0.0.1:${vitePort}/`,
    `http://127.0.0.1:${serverPort}/`,
  ];
  while (Date.now() < deadline) {
    if (exited) {
      return {
        ok: false,
        error: `App process exited (code ${exitCode}) before answering HTTP`,
        log,
      };
    }
    // Injected ports first (they are what a well-behaved script honors), then
    // whatever the log has advertised so far.
    const candidates = [
      ...injectedCandidates,
      ...announcedPorts(log)
        .filter((port) => port !== vitePort && port !== serverPort)
        .map((port) => `http://127.0.0.1:${port}/`),
    ];
    for (const url of candidates) {
      if (await probeHttp(url)) {
        return { ok: true, app: { baseUrl: url.replace(/\/$/, ''), stop, log } };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await stop();
  const announced = announcedPorts(log);
  const detail = announced.length
    ? ` (probed ports ${[vitePort, serverPort, ...announced].join(', ')})`
    : ` (probed ports ${vitePort}, ${serverPort}; the app announced none)`;
  return { ok: false, error: `App did not answer HTTP within ${timeoutMs}ms${detail}`, log };
};

// ————————————————————————————————————————————————————————————————————————
// Report rendering
// ————————————————————————————————————————————————————————————————————————

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function trimOutput(text: string, max = REPORT_OUTPUT_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `…(trimmed)\n${trimmed.slice(-max)}`;
}

function statusBadge(status: SwarmValidationCheckStatus): string {
  const colors: Record<SwarmValidationCheckStatus, string> = {
    passed: '#1a7f37',
    failed: '#b91c1c',
    skipped: '#6b7280',
    degraded: '#b45309',
  };
  return `<span style="display:inline-block;padding:2px 10px;border-radius:10px;color:#fff;background:${colors[status]};font-size:12px;text-transform:uppercase">${status}</span>`;
}

/** Blackboard `[permission]` audit lines (written by the permission broker). */
function permissionDecisionLines(blackboard: SwarmMessage[]): string[] {
  return blackboard
    .filter((message) => message.kind === 'system' && message.content.startsWith('[permission]'))
    .map((message) => message.content);
}

function renderAttemptHistory(
  history: SwarmValidationAttemptRecord[],
  currentAttempt: number,
  currentPassed: boolean,
): string {
  const rows = [
    ...history.map((entry) => {
      const outcome = entry.passed ? statusBadge('passed') : statusBadge('failed');
      const failures = entry.failedChecks.length
        ? ` — failed: ${escapeHtml(entry.failedChecks.join(', '))}`
        : '';
      const remediation = entry.remediationSteps?.length
        ? `<br/><span style="color:#6b7280">remediation dispatched: ${escapeHtml(entry.remediationSteps.join('; '))}</span>`
        : '';
      return `<li style="margin:4px 0">Attempt ${entry.attempt}: ${outcome}${failures}${remediation}</li>`;
    }),
    `<li style="margin:4px 0">Attempt ${currentAttempt}: ${statusBadge(currentPassed ? 'passed' : 'failed')} (this report)</li>`,
  ];
  return `<h2>Attempt history</h2>\n<ol style="padding-left:18px">${rows.join('\n')}</ol>`;
}

function renderHtmlReport(input: {
  swarmId: string;
  goal: string;
  roster: SwarmAgentSpec[];
  checks: SwarmValidationCheck[];
  screenshots: Array<{ target: string; relativePath: string }>;
  permissionDecisions: string[];
  degraded: boolean;
  passed: boolean;
  generatedAt: string;
  attempt: number;
  attemptHistory: SwarmValidationAttemptRecord[];
}): string {
  const rosterRows = input.roster
    .map(
      (seat) =>
        `<tr><td>${escapeHtml(seat.label)}</td><td>${escapeHtml(String(seat.kind))}</td><td>${escapeHtml(seat.provider ?? '—')}</td><td>${escapeHtml(seat.model ?? '—')}</td><td>${escapeHtml(seat.effort ?? '—')}</td><td>${escapeHtml(seat.permissionMode ?? '—')}</td></tr>`,
    )
    .join('\n');
  const checkBlocks = input.checks
    .map(
      (check) => `
      <section style="margin:14px 0;border:1px solid #e5e7eb;border-radius:8px;padding:12px">
        <h3 style="margin:0 0 6px">${escapeHtml(check.label)} ${statusBadge(check.status)}</h3>
        ${check.command ? `<code style="font-size:12px;color:#374151">${escapeHtml(check.command)}</code>` : ''}
        ${check.reason ? `<p style="margin:6px 0;color:#6b7280">${escapeHtml(check.reason)}</p>` : ''}
        ${check.output ? `<pre style="background:#0f172a;color:#e2e8f0;padding:10px;border-radius:6px;font-size:11px;white-space:pre-wrap;max-height:420px;overflow:hidden">${escapeHtml(redactSwarmText(trimOutput(check.output)))}</pre>` : ''}
        <p style="margin:4px 0 0;color:#9ca3af;font-size:11px">${check.durationMs}ms</p>
      </section>`,
    )
    .join('\n');
  const screenshotBlocks = input.screenshots
    .map(
      (shot) => `
      <figure style="margin:14px 0">
        <figcaption style="font-size:13px;color:#374151;margin-bottom:6px">${escapeHtml(shot.target)}</figcaption>
        <img src="${escapeHtml(shot.relativePath)}" style="max-width:100%;border:1px solid #e5e7eb;border-radius:8px" />
      </figure>`,
    )
    .join('\n');
  const permissionRows = input.permissionDecisions.length
    ? input.permissionDecisions.map((line) => `<li style="margin:3px 0;font-size:12px">${escapeHtml(line)}</li>`).join('\n')
    : '<li style="color:#6b7280">No broker permission decisions were recorded.</li>';

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Swarm validation report — ${escapeHtml(input.swarmId)}</title>
</head>
<body style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;color:#111827;max-width:960px;margin:24px auto;padding:0 16px">
  <h1 style="margin-bottom:2px">Swarm pre-PR validation ${statusBadge(input.passed ? 'passed' : 'failed')}${input.degraded ? ` ${statusBadge('degraded')}` : ''}</h1>
  <p style="color:#6b7280;margin-top:2px">swarm <code>${escapeHtml(input.swarmId)}</code> · attempt ${input.attempt} · generated ${escapeHtml(input.generatedAt)}</p>
  ${input.attempt > 1 || input.attemptHistory.length > 0 ? renderAttemptHistory(input.attemptHistory, input.attempt, input.passed) : ''}
  <h2>Goal</h2>
  <p>${escapeHtml(input.goal)}</p>
  <h2>Roster</h2>
  <table style="border-collapse:collapse;width:100%;font-size:13px">
    <thead><tr style="text-align:left;color:#6b7280"><th>Seat</th><th>Kind</th><th>Provider</th><th>Model</th><th>Effort</th><th>Permissions</th></tr></thead>
    <tbody>${rosterRows}</tbody>
  </table>
  <h2>Checks</h2>
  ${checkBlocks}
  <h2>Permission broker decisions</h2>
  <ul style="padding-left:18px">${permissionRows}</ul>
  <h2>Screenshots</h2>
  ${screenshotBlocks || '<p style="color:#6b7280">No screenshots (smoke skipped or degraded).</p>'}
</body>
</html>`;
}

// ————————————————————————————————————————————————————————————————————————
// Gate
// ————————————————————————————————————————————————————————————————————————

const STATIC_SCRIPTS = ['lint', 'typecheck', 'build', 'test'] as const;

function sanitizeSwarmIdForPath(swarmId: string): string {
  return swarmId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'swarm';
}

/** Directory where a swarm's validation report lives (under the primary project). */
export function swarmReportDir(primaryProjectPath: string, swarmId: string): string {
  return path.join(primaryProjectPath, 'tmp', 'cloudcli', 'swarm-reports', sanitizeSwarmIdForPath(swarmId));
}

async function readPackageScripts(workspaceRoot: string): Promise<Record<string, string> | null> {
  try {
    const raw = await readFile(path.join(workspaceRoot, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    if (!parsed || typeof parsed !== 'object' || !parsed.scripts || typeof parsed.scripts !== 'object') {
      return {};
    }
    const scripts: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed.scripts)) {
      if (typeof value === 'string') scripts[name] = value;
    }
    return scripts;
  } catch {
    return null;
  }
}

function normalizeTargets(targets: string[] | null | undefined): string[] {
  const cleaned = (targets ?? [])
    .filter((target): target is string => typeof target === 'string' && target.trim().length > 0)
    .map((target) => target.trim())
    .map((target) => (target.startsWith('/') ? target : `/${target}`))
    .filter((target) => /^\/[A-Za-z0-9/_.?=&#%-]*$/.test(target))
    .slice(0, 8);
  return cleaned.length > 0 ? [...new Set(cleaned)] : ['/'];
}

export async function runSwarmValidationGate(
  input: SwarmValidationGateInput,
): Promise<SwarmValidationGateResult> {
  const generatedAt = new Date().toISOString();
  const checks: SwarmValidationCheck[] = [];
  const screenshots: Array<{ target: string; path: string; relativePath: string }> = [];
  let degraded = false;

  const runCommand = commandRunnerOverride ?? defaultCommandRunner;
  const browserFactory = browserFactoryOverride ?? defaultBrowserFactory;
  const bootApp = appBooterOverride ?? defaultSwarmValidationAppBooter;

  const reportDir = swarmReportDir(input.primaryProjectPath, input.swarmId);
  const screensDir = path.join(reportDir, 'screens');
  await mkdir(screensDir, { recursive: true });

  // ——— 1. Static checks ———
  const scripts = await readPackageScripts(input.workspaceRoot);
  const cmdTimeout = validationCommandTimeoutMs();
  for (const name of STATIC_SCRIPTS) {
    if (!scripts || !scripts[name]) {
      checks.push({
        id: `static:${name}`,
        kind: 'static',
        label: `npm run ${name}`,
        command: null,
        status: 'skipped',
        reason: scripts === null ? 'no package.json in the worktree' : `script "${name}" not defined`,
        output: '',
        durationMs: 0,
      });
      continue;
    }
    const startedAt = Date.now();
    const result = await runCommand({
      command: 'npm',
      args: ['run', name],
      cwd: input.workspaceRoot,
      timeoutMs: cmdTimeout,
    });
    const ok = result.code === 0;
    checks.push({
      id: `static:${name}`,
      kind: 'static',
      label: `npm run ${name}`,
      command: scripts[name],
      status: ok ? 'passed' : 'failed',
      reason: ok
        ? null
        : result.timedOut
          ? `timed out after ${cmdTimeout}ms`
          : `exit code ${result.code ?? 'null'}`,
      output: trimOutput(`${result.stdout}\n${result.stderr}`),
      durationMs: Date.now() - startedAt,
    });
  }

  // ——— 2. Functional smoke ———
  let browser: SwarmValidationBrowser | null = null;
  try {
    browser = await browserFactory();
  } catch {
    browser = null;
  }

  const devScript = scripts?.['dev:isolated'] ? 'dev:isolated' : scripts?.dev ? 'dev' : null;
  if (!input.smokeEligible) {
    checks.push({
      id: 'smoke:boot',
      kind: 'smoke',
      label: 'Boot app in worktree',
      status: 'skipped',
      reason: 'workspace is not a git worktree (sandbox/non-git project); smoke skipped',
      output: '',
      durationMs: 0,
    });
  } else if (!devScript) {
    checks.push({
      id: 'smoke:boot',
      kind: 'smoke',
      label: 'Boot app in worktree',
      status: 'skipped',
      reason: 'no dev / dev:isolated script in package.json',
      output: '',
      durationMs: 0,
    });
  } else if (!browser) {
    degraded = true;
    checks.push({
      id: 'smoke:boot',
      kind: 'smoke',
      label: 'Boot app in worktree',
      status: 'degraded',
      reason: 'Playwright/Chromium is not available on this host — smoke skipped (gate not failed for missing tooling)',
      output: '',
      durationMs: 0,
    });
  } else {
    const startedAt = Date.now();
    const boot = await bootApp({
      cwd: input.workspaceRoot,
      script: devScript,
      timeoutMs: validationBootTimeoutMs(),
      workspaceTmpDir: path.join(input.workspaceRoot, 'tmp', 'cloudcli', 'swarm-validation'),
    });
    if (!boot.ok) {
      // A boot failure is a real failure, never a skip.
      checks.push({
        id: 'smoke:boot',
        kind: 'smoke',
        label: `Boot app (npm run ${devScript})`,
        command: devScript,
        status: 'failed',
        reason: boot.error,
        output: trimOutput(boot.log ?? ''),
        durationMs: Date.now() - startedAt,
      });
    } else {
      checks.push({
        id: 'smoke:boot',
        kind: 'smoke',
        label: `Boot app (npm run ${devScript})`,
        command: devScript,
        status: 'passed',
        reason: `answered at ${boot.app.baseUrl}`,
        output: '',
        durationMs: Date.now() - startedAt,
      });
      const targets = normalizeTargets(input.verificationTargets);
      for (let index = 0; index < targets.length; index += 1) {
        const target = targets[index];
        const url = `${boot.app.baseUrl}${target}`;
        const visitStarted = Date.now();
        try {
          const png = await browser.capture(url);
          const fileName = `shot-${String(index + 1).padStart(2, '0')}.png`;
          const filePath = path.join(screensDir, fileName);
          await writeFile(filePath, png);
          screenshots.push({ target, path: filePath, relativePath: `screens/${fileName}` });
          checks.push({
            id: `smoke:visit:${target}`,
            kind: 'smoke',
            label: `Visit ${target}`,
            command: url,
            status: 'passed',
            output: '',
            durationMs: Date.now() - visitStarted,
          });
        } catch (error) {
          checks.push({
            id: `smoke:visit:${target}`,
            kind: 'smoke',
            label: `Visit ${target}`,
            command: url,
            status: 'failed',
            reason: error instanceof Error ? error.message : String(error),
            output: '',
            durationMs: Date.now() - visitStarted,
          });
        }
      }
      await boot.app.stop().catch(() => undefined);
    }
  }

  // ——— 3. Report (HTML always; PDF when a browser is available) ———
  const passed = !checks.some((check) => check.status === 'failed');
  const permissionDecisions = permissionDecisionLines(input.blackboard);

  const html = renderHtmlReport({
    swarmId: input.swarmId,
    goal: input.goal,
    roster: input.roster,
    checks,
    screenshots: screenshots.map(({ target, relativePath }) => ({ target, relativePath })),
    permissionDecisions,
    degraded: degraded || !browser,
    passed,
    generatedAt,
    attempt: input.attempt ?? 1,
    attemptHistory: input.attemptHistory ?? [],
  });
  const htmlPath = path.join(reportDir, 'report.html');
  await writeFile(htmlPath, html, 'utf8');

  let pdfPath: string | null = null;
  if (browser) {
    const pdfStarted = Date.now();
    try {
      const pdf = await browser.renderPdf(pathToFileURL(htmlPath).href);
      pdfPath = path.join(reportDir, 'report.pdf');
      await writeFile(pdfPath, pdf);
      checks.push({
        id: 'report:pdf',
        kind: 'report',
        label: 'Render PDF report',
        status: 'passed',
        output: '',
        durationMs: Date.now() - pdfStarted,
      });
    } catch (error) {
      // A broken PDF renderer must not block the PR when everything else passed.
      degraded = true;
      checks.push({
        id: 'report:pdf',
        kind: 'report',
        label: 'Render PDF report',
        status: 'degraded',
        reason: `PDF rendering failed: ${error instanceof Error ? error.message : String(error)} (HTML report available)`,
        output: '',
        durationMs: Date.now() - pdfStarted,
      });
    }
  } else {
    degraded = true;
    checks.push({
      id: 'report:pdf',
      kind: 'report',
      label: 'Render PDF report',
      status: 'degraded',
      reason: 'Playwright unavailable — HTML report only',
      output: '',
      durationMs: 0,
    });
  }
  try {
    await browser?.close();
  } catch {
    /* optional */
  }

  const failedChecks = checks.filter((check) => check.status === 'failed');
  const summary = failedChecks.length
    ? `Validation FAILED: ${failedChecks.map((check) => `${check.label} (${check.reason ?? 'failed'})`).join('; ')}`
    : `Validation passed${degraded ? ' (degraded: smoke/PDF tooling unavailable)' : ''}: ${checks
        .filter((check) => check.status === 'passed')
        .map((check) => check.label)
        .join(', ') || 'no applicable checks'}`;

  const result: SwarmValidationGateResult = {
    passed,
    degraded,
    checks,
    screenshots: screenshots.map(({ target, path: filePath }) => ({ target, path: filePath })),
    reportDir,
    htmlPath,
    pdfPath,
    summary,
    generatedAt,
  };

  try {
    await writeFile(
      path.join(reportDir, 'summary.json'),
      JSON.stringify(
        {
          swarmId: input.swarmId,
          goal: input.goal,
          passed,
          degraded,
          generatedAt,
          summary,
          attempt: input.attempt ?? 1,
          attemptHistory: input.attemptHistory ?? [],
          checks: checks.map(({ output: _output, ...rest }) => rest),
          screenshots: result.screenshots,
          pdfPath,
          htmlPath,
        },
        null,
        2,
      ),
      'utf8',
    );
  } catch {
    /* report metadata is best-effort */
  }

  return result;
}
