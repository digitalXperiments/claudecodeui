import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test, { mock } from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { appConfigDb, closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import type { ProviderUsage, ProviderUsageResponse, UsageWindow } from '@/modules/provider-usage/index.js';
import { providerAuthService, sessionHandoffService } from '@/modules/providers/index.js';
import { recordNormalizedRunEvent, runService } from '@/modules/runs/index.js';
import { makeScratchDir } from '@/shared/scratch.js';
import type { NormalizedMessage } from '@/shared/types.js';

import { continuityRepository } from '../continuity.repository.js';
import continuityRoutes from '../continuity.routes.js';
import {
  configureContinuityUsageLoader,
  runContinuitySchedulerTick,
} from '../continuity-scheduler.service.js';
import {
  configureContinuityRuntimes,
  CONTINUITY_DEFAULTS_KEY,
  continuityService,
  DEFAULT_CONTINUITY_POLICY,
} from '../continuity.service.js';
import { detectProviderLimit } from '../limit-detection.js';

async function withDatabase(callback: (root: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await makeScratchDir('continuity-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  configureContinuityUsageLoader(async ({ now }) => ({
    fetchedAt: null,
    attemptedAt: new Date(now).toISOString(),
    providers: [],
    cached: false,
  }));
  try {
    await callback(root);
  } finally {
    configureContinuityRuntimes({});
    configureContinuityUsageLoader();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
}

function usageWindow(overrides: Partial<UsageWindow> = {}): UsageWindow {
  return {
    id: 'primary',
    label: 'Primary',
    used: null,
    limit: null,
    remaining: null,
    remainingRatio: null,
    resetsAt: null,
    unit: 'requests',
    ...overrides,
  };
}

function usageRow(
  providerId: string,
  nowMs: number,
  windows: UsageWindow[],
  overrides: Partial<ProviderUsage> = {},
): ProviderUsage {
  return {
    providerId,
    displayName: providerId,
    signedIn: true,
    planName: null,
    primaryWindowId: windows[0]?.id ?? null,
    windows,
    status: 'ok',
    error: null,
    fetchedAt: new Date(nowMs).toISOString(),
    ...overrides,
  };
}

function usageSnapshot(nowMs: number, providers: ProviderUsage[]): ProviderUsageResponse {
  return {
    fetchedAt: new Date(nowMs).toISOString(),
    attemptedAt: new Date(nowMs).toISOString(),
    providers,
    cached: false,
  };
}

function providerMessage(content: string, extra: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    id: `message-${Math.random()}`,
    sessionId: 'provider-session',
    timestamp: new Date().toISOString(),
    provider: 'claude',
    kind: 'error',
    content,
    ...extra,
  };
}

async function withContinuityHttpServer(
  callback: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(continuityRoutes);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const statusCode = error && typeof error === 'object' && 'statusCode' in error
      ? Number(error.statusCode)
      : 500;
    const message = error instanceof Error ? error.message : String(error);
    res.status(statusCode).json({ error: { message } });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('detectProviderLimit reads Claude reset sentinels and generic retry durations', () => {
  const resetSeconds = Math.floor(Date.now() / 1000) + 3600;
  const claude = detectProviderLimit(providerMessage(`Claude AI usage limit reached|${resetSeconds}`));
  assert.equal(claude?.retryAt, new Date(resetSeconds * 1000).toISOString());
  assert.equal(claude?.resetTimeSource, 'message');

  const now = Date.now();
  const generic = detectProviderLimit(providerMessage('HTTP 429: too many requests; try again in 12 minutes'), now);
  assert.equal(generic?.retryAt, new Date(now + 12 * 60_000).toISOString());
  assert.equal(detectProviderLimit(providerMessage('The compiler returned 429 type errors')), null);
});

test('global defaults persist in app_config and apply to sessions without an override', async () => {
  await withDatabase(async (root) => {
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    const project = projectsDb.createProjectPath(projectPath).project!;
    sessionsDb.createAppSession('session-inherited', 'claude', projectPath);

    const defaults = continuityService.putDefaults({
      mode: 'smart',
      fallbackProviders: ['codex', 'cursor', 'codex'],
      handoffMode: 'full',
      maxAttempts: 40,
      maxWaitSeconds: -10,
      unknownResetDelaySeconds: 10,
    });
    assert.deepEqual(continuityService.getDefaults(), defaults);
    assert.deepEqual(JSON.parse(appConfigDb.get(CONTINUITY_DEFAULTS_KEY)!), {
      mode: 'smart',
      fallbackProviders: ['codex', 'cursor'],
      handoffMode: 'full',
      maxAttempts: 10,
      maxWaitSeconds: 0,
      unknownResetDelaySeconds: 30,
      inPlaceHandoff: false,
      boomerangMode: 'off',
      preflightQuotaGuard: 'warn',
      preflightThresholdRatio: 0.05,
      tierMappingEnabled: true,
      checkpointToolsEnabled: true,
      subagentContinuityEnabled: true,
    });

    const state = continuityService.getState('session-inherited');
    assert.equal(state.policySource, 'global');
    assert.equal(state.policy.mode, 'smart');
    assert.deepEqual(state.policy.fallbackProviders, ['codex', 'cursor']);
    assert.equal(state.policy.handoffMode, 'full');
    assert.equal(state.policy.maxAttempts, 10);

    const run = runService.create({
      source: 'chat',
      projectId: project.project_id,
      appSessionId: 'session-inherited',
      provider: 'claude',
    });
    const resetSeconds = Math.floor(Date.now() / 1000) + 3600;
    const recovery = await continuityService.observeRunEvent(
      run.run_id,
      providerMessage(`Claude AI usage limit reached|${resetSeconds}`),
    );
    assert.equal(recovery?.action, 'handoff');
    assert.equal(recovery?.fallbackProvider, 'codex');
    assert.deepEqual(recovery?.policy, defaults);

    continuityService.putDefaults({ mode: 'wait' });
    assert.equal(continuityRepository.getPolicy('session-inherited'), null);
    assert.equal(continuityService.getState('session-inherited').policy.mode, 'wait');
  });
});

test('malformed saved defaults safely fall back and the next PUT repairs app_config', async () => {
  await withDatabase(async (root) => {
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    projectsDb.createProjectPath(projectPath);
    sessionsDb.createAppSession('session-malformed-defaults', 'claude', projectPath);

    appConfigDb.set(CONTINUITY_DEFAULTS_KEY, '{broken json');
    assert.deepEqual(continuityService.getDefaults(), DEFAULT_CONTINUITY_POLICY);
    assert.equal(continuityService.getState('session-malformed-defaults').policySource, 'builtin');

    appConfigDb.set(CONTINUITY_DEFAULTS_KEY, JSON.stringify(['not', 'an', 'object']));
    assert.deepEqual(continuityService.getDefaults(), DEFAULT_CONTINUITY_POLICY);

    const repaired = continuityService.putDefaults({
      mode: 'smart',
      fallbackProviders: ['codex', 'invalid-provider' as never, 'codex', 'cursor'],
      maxAttempts: 99,
      maxWaitSeconds: -1,
      unknownResetDelaySeconds: 1,
    });
    assert.deepEqual(repaired, {
      mode: 'smart',
      fallbackProviders: ['codex', 'cursor'],
      handoffMode: 'summary',
      maxAttempts: 10,
      maxWaitSeconds: 0,
      unknownResetDelaySeconds: 30,
      inPlaceHandoff: false,
      boomerangMode: 'off',
      preflightQuotaGuard: 'warn',
      preflightThresholdRatio: 0.05,
      tierMappingEnabled: true,
      checkpointToolsEnabled: true,
      subagentContinuityEnabled: true,
    });
    assert.deepEqual(JSON.parse(appConfigDb.get(CONTINUITY_DEFAULTS_KEY)!), repaired);
  });
});

test('defaults HTTP routes return the stable success envelope and normalized persisted values', async () => {
  await withDatabase(async () => {
    await withContinuityHttpServer(async (baseUrl) => {
      const initialResponse = await fetch(`${baseUrl}/continuity/defaults`);
      assert.equal(initialResponse.status, 200);
      assert.deepEqual(await initialResponse.json(), {
        success: true,
        data: { defaults: DEFAULT_CONTINUITY_POLICY },
      });

      const updateResponse = await fetch(`${baseUrl}/continuity/defaults`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'switch',
          fallbackProviders: ['codex', 'codex', 'cursor', 'not-real'],
          handoffMode: 'full',
          maxAttempts: 0,
          maxWaitSeconds: 999999999,
          unknownResetDelaySeconds: 45,
        }),
      });
      assert.equal(updateResponse.status, 200);
      const expected = {
        mode: 'switch',
        fallbackProviders: ['codex', 'cursor'],
        handoffMode: 'full',
        maxAttempts: 1,
        maxWaitSeconds: 7 * 24 * 60 * 60,
        unknownResetDelaySeconds: 45,
      inPlaceHandoff: false,
      boomerangMode: 'off',
      preflightQuotaGuard: 'warn',
      preflightThresholdRatio: 0.05,
      tierMappingEnabled: true,
      checkpointToolsEnabled: true,
      subagentContinuityEnabled: true,
      };
      assert.deepEqual(await updateResponse.json(), {
        success: true,
        data: { defaults: expected },
      });
      assert.deepEqual(JSON.parse(appConfigDb.get(CONTINUITY_DEFAULTS_KEY)!), expected);
    });
  });
});

test('malformed fields in a partial defaults update preserve the current effective values', async () => {
  await withDatabase(async () => {
    const initial = continuityService.putDefaults({
      mode: 'smart',
      fallbackProviders: ['codex'],
      handoffMode: 'full',
      maxAttempts: 7,
      maxWaitSeconds: 120,
      unknownResetDelaySeconds: 90,
    });
    const updated = continuityService.putDefaults({
      mode: 'invalid' as never,
      fallbackProviders: null as never,
      handoffMode: 'invalid' as never,
      maxAttempts: 2.5,
      maxWaitSeconds: Number.POSITIVE_INFINITY,
      unknownResetDelaySeconds: Number.NaN,
    });
    assert.deepEqual(updated, initial);
    assert.deepEqual(JSON.parse(appConfigDb.get(CONTINUITY_DEFAULTS_KEY)!), initial);
  });
});

test('session policy overrides global defaults and partial composer updates inherit the effective default', async () => {
  await withDatabase(async (root) => {
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    projectsDb.createProjectPath(projectPath);
    sessionsDb.createAppSession('session-override', 'claude', projectPath);
    continuityService.putDefaults({
      mode: 'wait',
      fallbackProviders: ['codex'],
      handoffMode: 'full',
      maxAttempts: 6,
      maxWaitSeconds: 300,
      unknownResetDelaySeconds: 240,
    });

    const override = continuityService.putPolicy('session-override', { mode: 'off' });
    assert.equal(override.mode, 'off');
    assert.deepEqual(override.fallbackProviders, ['codex']);
    assert.equal(override.handoffMode, 'full');
    assert.equal(override.maxAttempts, 6);
    assert.equal(continuityService.getState('session-override').policySource, 'session');

    continuityService.putDefaults({ mode: 'smart', maxAttempts: 2 });
    const unchanged = continuityService.getState('session-override').policy;
    assert.equal(unchanged.mode, 'off');
    assert.equal(unchanged.maxAttempts, 6);
  });
});

test('turning global continuity off cancels inherited recoveries but preserves explicit policies', async () => {
  await withDatabase(async (root) => {
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    const project = projectsDb.createProjectPath(projectPath).project!;
    sessionsDb.createAppSession('session-global', 'claude', projectPath);
    sessionsDb.createAppSession('session-explicit', 'claude', projectPath);
    continuityService.putDefaults({ mode: 'wait' });
    continuityService.putPolicy('session-explicit', { mode: 'wait' });

    const inheritedRun = runService.create({
      source: 'chat',
      projectId: project.project_id,
      appSessionId: 'session-global',
      provider: 'claude',
    });
    const explicitRun = runService.create({
      source: 'chat',
      projectId: project.project_id,
      appSessionId: 'session-explicit',
      provider: 'claude',
    });
    const resetSeconds = Math.floor(Date.now() / 1000) + 3600;
    const signal = providerMessage(`Claude AI usage limit reached|${resetSeconds}`);
    const inheritedRecovery = await continuityService.observeRunEvent(inheritedRun.run_id, signal);
    const explicitRecovery = await continuityService.observeRunEvent(explicitRun.run_id, signal);
    assert.equal(inheritedRecovery?.status, 'waiting');
    assert.equal(explicitRecovery?.status, 'waiting');

    continuityService.putDefaults({ mode: 'off' });
    assert.equal(continuityRepository.getRecovery(inheritedRecovery!.recoveryId)?.status, 'cancelled');
    assert.equal(continuityRepository.getRecovery(explicitRecovery!.recoveryId)?.status, 'waiting');
  });
});

test('wait policy creates one durable recovery with the provider reset time', async () => {
  await withDatabase(async (root) => {
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    const project = projectsDb.createProjectPath(projectPath).project!;
    sessionsDb.createAppSession('session-1', 'claude', projectPath);
    continuityService.putPolicy('session-1', { mode: 'wait' });
    const run = runService.create({
      source: 'chat',
      projectId: project.project_id,
      appSessionId: 'session-1',
      provider: 'claude',
      title: 'Keep working',
    });
    const resetSeconds = Math.floor(Date.now() / 1000) + 7200;
    const message = providerMessage(`Claude AI usage limit reached|${resetSeconds}`);

    const first = await continuityService.observeRunEvent(run.run_id, message);
    const second = await continuityService.observeRunEvent(run.run_id, message);

    assert.ok(first);
    assert.equal(second?.recoveryId, first?.recoveryId);
    assert.equal(first?.status, 'waiting');
    assert.equal(first?.action, 'resume');
    assert.equal(first?.resetTimeSource, 'message');
    assert.equal(Date.parse(first!.retryAt!), resetSeconds * 1000 + 15_000);
  });
});

test('smart policy switches immediately when the reset exceeds max wait', async () => {
  await withDatabase(async (root) => {
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    const project = projectsDb.createProjectPath(projectPath).project!;
    sessionsDb.createAppSession('session-smart', 'claude', projectPath);
    continuityService.putPolicy('session-smart', {
      mode: 'smart',
      fallbackProviders: ['codex'],
      maxWaitSeconds: 60,
    });
    const run = runService.create({
      source: 'chat',
      projectId: project.project_id,
      appSessionId: 'session-smart',
      provider: 'claude',
    });
    const resetSeconds = Math.floor(Date.now() / 1000) + 3600;
    const recovery = await continuityService.observeRunEvent(
      run.run_id,
      providerMessage(`Claude AI usage limit reached|${resetSeconds}`),
    );

    assert.equal(recovery?.action, 'handoff');
    assert.equal(recovery?.fallbackProvider, 'codex');
    assert.ok(Date.parse(recovery!.retryAt!) <= Date.now() + 1000);
  });
});

test('an inherited handoff uses its normalized recovery snapshot after global defaults change', async () => {
  await withDatabase(async (root) => {
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    const project = projectsDb.createProjectPath(projectPath).project!;
    sessionsDb.createAppSession('session-snapshot', 'claude', projectPath);
    continuityService.putDefaults({
      mode: 'switch',
      fallbackProviders: ['codex', 'cursor'],
      handoffMode: 'full',
      maxAttempts: 4,
    });
    const source = runService.create({
      source: 'chat',
      projectId: project.project_id,
      appSessionId: 'session-snapshot',
      provider: 'claude',
    });
    runService.markTerminal(source.run_id, { status: 'succeeded', exitCode: 0 });
    const resetSeconds = Math.floor(Date.now() / 1000) + 3600;
    const recovery = await continuityService.observeRunEvent(
      source.run_id,
      providerMessage(`Claude AI usage limit reached|${resetSeconds}`),
    );
    assert.equal(recovery?.action, 'handoff');
    assert.equal(recovery?.policy.handoffMode, 'full');

    // The already-scheduled recovery should keep its snapshot. The current
    // global policy controls subsequent turns in the handed-off session.
    continuityService.putDefaults({ mode: 'wait', handoffMode: 'summary' });

    const authMock = mock.method(providerAuthService, 'getProviderAuthStatus', async (provider: string) => ({
      installed: true,
      provider,
      authenticated: provider === 'cursor',
      email: provider === 'cursor' ? 'cursor@example.test' : null,
      method: provider === 'cursor' ? 'oauth' : null,
      ...(provider === 'cursor' ? {} : { error: 'Not connected' }),
    }));
    const handoffMock = mock.method(sessionHandoffService, 'createHandoffSession', async (input: { provider?: string }) => {
      sessionsDb.createAppSession('session-snapshot-handoff', 'cursor', projectPath);
      return {
        sessionId: 'session-snapshot-handoff',
        provider: 'cursor' as const,
        projectPath,
        handoffPrompt: 'Continue from the snapshot.',
      };
    });
    configureContinuityRuntimes({
      cursor: async (_command, _options, writer) => {
        (writer as { send: (message: Partial<NormalizedMessage>) => void }).send({
          kind: 'complete', provider: 'cursor', exitCode: 0, success: true,
        });
      },
    });

    try {
      await runContinuitySchedulerTick(Date.now() + 1_000);
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.deepEqual(
        authMock.mock.calls.map((call) => call.arguments[0]),
        ['codex', 'cursor'],
      );
      assert.equal(handoffMock.mock.calls.length, 1);
      assert.deepEqual(handoffMock.mock.calls[0].arguments[0], {
        sourceSessionId: 'session-snapshot',
        targetProvider: 'cursor',
        mode: 'full',
        saveToFile: true,
        includeGitState: true,
        includeKanbanState: true,
      });
      assert.equal(continuityRepository.getRecovery(recovery!.recoveryId)?.status, 'completed');
      assert.equal(continuityRepository.getRecovery(recovery!.recoveryId)?.fallbackProvider, 'cursor');
      assert.equal(continuityRepository.getPolicy('session-snapshot-handoff'), null);
      const handedOffState = continuityService.getState('session-snapshot-handoff');
      assert.equal(handedOffState.policySource, 'global');
      assert.equal(handedOffState.policy.mode, 'wait');
      assert.equal(handedOffState.policy.handoffMode, 'summary');
    } finally {
      handoffMock.mock.restore();
      authMock.mock.restore();
    }
  });
});

test('failed runs preserve the provider error for limit classification', async () => {
  await withDatabase(async (root) => {
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    const project = projectsDb.createProjectPath(projectPath).project!;
    const run = runService.create({ source: 'chat', projectId: project.project_id, provider: 'codex' });
    recordNormalizedRunEvent(run.run_id, {
      ...providerMessage('HTTP 429: too many requests'),
      provider: 'codex',
    }, 'chat');
    recordNormalizedRunEvent(run.run_id, {
      ...providerMessage(''),
      provider: 'codex',
      kind: 'complete',
      exitCode: 1,
      success: false,
    }, 'chat');
    assert.equal(runService.get(run.run_id)?.error_summary, 'HTTP 429: too many requests');
  });
});

test('due wait recovery resumes the same provider in a child run', async () => {
  await withDatabase(async (root) => {
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    const project = projectsDb.createProjectPath(projectPath).project!;
    sessionsDb.createAppSession('session-resume', 'claude', projectPath, { permissionMode: 'default' });
    continuityService.putPolicy('session-resume', { mode: 'wait', maxAttempts: 2 });
    const source = runService.create({
      source: 'chat',
      projectId: project.project_id,
      appSessionId: 'session-resume',
      provider: 'claude',
      title: 'Resume me',
    });
    runService.markTerminal(source.run_id, { status: 'succeeded', exitCode: 0 });

    configureContinuityRuntimes({
      claude: async (_command, _options, writer) => {
        (writer as { send: (message: Partial<NormalizedMessage>) => void }).send({
          kind: 'complete',
          provider: 'claude',
          exitCode: 0,
          success: true,
        });
      },
    });
    const pastSeconds = Math.floor(Date.now() / 1000) - 3600;
    const recovery = await continuityService.observeRunEvent(
      source.run_id,
      providerMessage(`Claude AI usage limit reached|${pastSeconds}`),
    );
    assert.ok(recovery);

    await runContinuitySchedulerTick();
    await new Promise<void>((resolve) => setImmediate(resolve));

    const stored = continuityRepository.getRecovery(recovery!.recoveryId);
    assert.equal(stored?.status, 'completed');
    const child = runService.list({ limit: 20 }).runs.find((run) => run.parent_run_id === source.run_id);
    assert.equal(child?.trigger, 'continuity');
    assert.equal(child?.provider, 'claude');
    assert.equal(child?.app_session_id, 'session-resume');
  });
});

test('fresh available quota wakes a waiting recovery before its old retry time', async () => {
  await withDatabase(async (root) => {
    const nowMs = Date.now();
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    const project = projectsDb.createProjectPath(projectPath).project!;
    sessionsDb.createAppSession('session-early-reset', 'claude', projectPath);
    continuityService.putPolicy('session-early-reset', { mode: 'wait' });
    const source = runService.create({
      source: 'chat',
      projectId: project.project_id,
      appSessionId: 'session-early-reset',
      provider: 'claude',
    });
    runService.markTerminal(source.run_id, { status: 'succeeded', exitCode: 0 });
    configureContinuityRuntimes({
      claude: async (_command, _options, writer) => {
        (writer as { send: (message: Partial<NormalizedMessage>) => void }).send({
          kind: 'complete', provider: 'claude', exitCode: 0, success: true,
        });
      },
    });

    const oldResetSeconds = Math.floor(nowMs / 1000) + 3600;
    const recovery = await continuityService.observeRunEvent(
      source.run_id,
      providerMessage(`Claude AI usage limit reached|${oldResetSeconds}`),
    );
    let usageLoads = 0;
    configureContinuityUsageLoader(async () => {
      usageLoads += 1;
      return usageSnapshot(nowMs, [
        usageRow('claude', nowMs, [usageWindow({ remaining: 42, limit: 100 })]),
      ]);
    });

    await runContinuitySchedulerTick(nowMs);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(usageLoads, 1);
    assert.equal(continuityRepository.getRecovery(recovery!.recoveryId)?.status, 'completed');
    assert.ok(Date.parse(recovery!.retryAt!) > nowMs);
  });
});

test('fresh exhausted quota postpones a timer-due recovery to the latest blocking reset', async () => {
  await withDatabase(async (root) => {
    const nowMs = Date.now();
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    const project = projectsDb.createProjectPath(projectPath).project!;
    sessionsDb.createAppSession('session-later-reset', 'claude', projectPath);
    continuityService.putPolicy('session-later-reset', { mode: 'wait' });
    const source = runService.create({
      source: 'chat',
      projectId: project.project_id,
      appSessionId: 'session-later-reset',
      provider: 'claude',
    });
    runService.markTerminal(source.run_id, { status: 'succeeded', exitCode: 0 });
    let dispatches = 0;
    configureContinuityRuntimes({
      claude: async () => {
        dispatches += 1;
      },
    });
    const recovery = await continuityService.observeRunEvent(
      source.run_id,
      providerMessage(`Claude AI usage limit reached|${Math.floor(nowMs / 1000) - 60}`),
    );
    const firstBlockingReset = nowMs + 30 * 60_000;
    const latestBlockingReset = nowMs + 60 * 60_000;
    configureContinuityUsageLoader(async () => usageSnapshot(nowMs, [
      usageRow('claude', nowMs, [
        usageWindow({ id: 'primary', remainingRatio: 0.5 }),
        usageWindow({ id: 'short', remaining: 0, limit: 100, resetsAt: new Date(firstBlockingReset).toISOString() }),
        usageWindow({ id: 'long', used: 100, limit: 100, resetsAt: new Date(latestBlockingReset).toISOString() }),
      ]),
    ]));

    await runContinuitySchedulerTick(nowMs);

    const stored = continuityRepository.getRecovery(recovery!.recoveryId);
    assert.equal(dispatches, 0);
    assert.equal(stored?.status, 'waiting');
    assert.equal(stored?.resetTimeSource, 'provider');
    assert.equal(Date.parse(stored!.retryAt!), latestBlockingReset + 15_000);
  });
});

test('inconclusive quota refresh preserves retryAt and the due timer still dispatches', async () => {
  await withDatabase(async (root) => {
    const nowMs = Date.now();
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    const project = projectsDb.createProjectPath(projectPath).project!;
    sessionsDb.createAppSession('session-inconclusive', 'claude', projectPath);
    continuityService.putPolicy('session-inconclusive', { mode: 'wait' });
    const source = runService.create({
      source: 'chat',
      projectId: project.project_id,
      appSessionId: 'session-inconclusive',
      provider: 'claude',
    });
    runService.markTerminal(source.run_id, { status: 'succeeded', exitCode: 0 });
    configureContinuityRuntimes({
      claude: async (_command, _options, writer) => {
        (writer as { send: (message: Partial<NormalizedMessage>) => void }).send({
          kind: 'complete', provider: 'claude', exitCode: 0, success: true,
        });
      },
    });
    const recovery = await continuityService.observeRunEvent(
      source.run_id,
      providerMessage(`Claude AI usage limit reached|${Math.floor(nowMs / 1000) - 60}`),
    );
    const originalRetryAt = new Date(nowMs - 1_000).toISOString();
    continuityRepository.update(recovery!.recoveryId, { retryAt: originalRetryAt });
    configureContinuityUsageLoader(async () => usageSnapshot(nowMs, [
      usageRow(
        'claude',
        nowMs,
        [usageWindow({ remainingRatio: 0.8 })],
        { status: 'stale', error: 'refresh failed' },
      ),
    ]));

    await runContinuitySchedulerTick(nowMs);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const stored = continuityRepository.getRecovery(recovery!.recoveryId);
    assert.equal(stored?.status, 'completed');
    assert.equal(stored?.retryAt, originalRetryAt);
  });
});

test('providers without live usage adapters retain timer-only recovery behavior', async () => {
  await withDatabase(async (root) => {
    const nowMs = Date.now();
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    const project = projectsDb.createProjectPath(projectPath).project!;
    sessionsDb.createAppSession('session-unsupported', 'opencode', projectPath);
    continuityService.putPolicy('session-unsupported', { mode: 'wait' });
    const source = runService.create({
      source: 'chat',
      projectId: project.project_id,
      appSessionId: 'session-unsupported',
      provider: 'opencode',
    });
    runService.markTerminal(source.run_id, { status: 'succeeded', exitCode: 0 });
    configureContinuityRuntimes({
      opencode: async (_command, _options, writer) => {
        (writer as { send: (message: Partial<NormalizedMessage>) => void }).send({
          kind: 'complete', provider: 'opencode', exitCode: 0, success: true,
        });
      },
    });
    const recovery = await continuityService.observeRunEvent(
      source.run_id,
      providerMessage(
        `HTTP 429: too many requests; retry at ${new Date(nowMs - 60_000).toISOString()}`,
        { provider: 'opencode' },
      ),
    );
    assert.ok(recovery);
    continuityRepository.update(recovery!.recoveryId, { retryAt: new Date(nowMs - 1_000).toISOString() });
    let usageLoads = 0;
    configureContinuityUsageLoader(async () => {
      usageLoads += 1;
      return usageSnapshot(nowMs, []);
    });

    await runContinuitySchedulerTick(nowMs);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(usageLoads, 0);
    assert.equal(continuityRepository.getRecovery(recovery!.recoveryId)?.status, 'completed');
  });
});

test('one provider-usage fetch wakes multiple matching recoveries in a sweep', async () => {
  await withDatabase(async (root) => {
    const nowMs = Date.now();
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    const project = projectsDb.createProjectPath(projectPath).project!;
    configureContinuityRuntimes({
      claude: async (_command, _options, writer) => {
        (writer as { send: (message: Partial<NormalizedMessage>) => void }).send({
          kind: 'complete', provider: 'claude', exitCode: 0, success: true,
        });
      },
    });

    const recoveries = [];
    for (const suffix of ['one', 'two']) {
      const sessionId = `session-batched-${suffix}`;
      sessionsDb.createAppSession(sessionId, 'claude', projectPath);
      continuityService.putPolicy(sessionId, { mode: 'wait' });
      const source = runService.create({
        source: 'chat',
        projectId: project.project_id,
        appSessionId: sessionId,
        provider: 'claude',
      });
      runService.markTerminal(source.run_id, { status: 'succeeded', exitCode: 0 });
      recoveries.push(await continuityService.observeRunEvent(
        source.run_id,
        providerMessage(`Claude AI usage limit reached|${Math.floor(nowMs / 1000) + 3600}`),
      ));
    }
    let usageLoads = 0;
    configureContinuityUsageLoader(async () => {
      usageLoads += 1;
      return usageSnapshot(nowMs, [
        usageRow('claude', nowMs, [usageWindow({ remainingRatio: 0.25 })]),
      ]);
    });

    await runContinuitySchedulerTick(nowMs);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(usageLoads, 1);
    assert.deepEqual(
      recoveries.map((recovery) => continuityRepository.getRecovery(recovery!.recoveryId)?.status),
      ['completed', 'completed'],
    );
  });
});

test('unknown reset for a live-usage provider parks on maxWait instead of the no-meter delay', async () => {
  await withDatabase(async (root) => {
    const nowMs = Date.now();
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    const project = projectsDb.createProjectPath(projectPath).project!;
    sessionsDb.createAppSession('session-poll-park', 'claude', projectPath);
    continuityService.putPolicy('session-poll-park', {
      mode: 'wait',
      unknownResetDelaySeconds: 30,
      maxWaitSeconds: 3600,
    });
    const source = runService.create({
      source: 'chat',
      projectId: project.project_id,
      appSessionId: 'session-poll-park',
      provider: 'claude',
    });
    const recovery = await continuityService.observeRunEvent(
      source.run_id,
      providerMessage('Claude usage limit reached'),
    );
    assert.equal(recovery?.resetTimeSource, 'fallback');
    const retryMs = Date.parse(recovery!.retryAt!);
    assert.ok(retryMs >= nowMs + 3_000);
    assert.ok(retryMs <= nowMs + 3_700_000);
    assert.ok(retryMs > nowMs + 60_000);
  });
});

test('exhausted quota without a reset time postpones a due wait instead of dispatching', async () => {
  await withDatabase(async (root) => {
    const nowMs = Date.now();
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    const project = projectsDb.createProjectPath(projectPath).project!;
    sessionsDb.createAppSession('session-poll-defer', 'claude', projectPath);
    continuityService.putPolicy('session-poll-defer', { mode: 'wait' });
    const source = runService.create({
      source: 'chat',
      projectId: project.project_id,
      appSessionId: 'session-poll-defer',
      provider: 'claude',
    });
    runService.markTerminal(source.run_id, { status: 'succeeded', exitCode: 0 });
    let dispatches = 0;
    configureContinuityRuntimes({
      claude: async () => {
        dispatches += 1;
      },
    });
    const recovery = await continuityService.observeRunEvent(
      source.run_id,
      providerMessage('Claude usage limit reached'),
    );
    continuityRepository.update(recovery!.recoveryId, { retryAt: new Date(nowMs - 1_000).toISOString() });
    configureContinuityUsageLoader(async () => usageSnapshot(nowMs, [
      usageRow('claude', nowMs, [usageWindow({ remaining: 0, limit: 100, resetsAt: null })]),
    ]));

    await runContinuitySchedulerTick(nowMs);

    const stored = continuityRepository.getRecovery(recovery!.recoveryId);
    assert.equal(dispatches, 0);
    assert.equal(stored?.status, 'waiting');
    assert.equal(stored?.resetTimeSource, 'provider');
    assert.ok(Date.parse(stored!.retryAt!) > nowMs);
  });
});

test('available quota wakes a live-usage wait that had no reset time', async () => {
  await withDatabase(async (root) => {
    const nowMs = Date.now();
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    const project = projectsDb.createProjectPath(projectPath).project!;
    sessionsDb.createAppSession('session-poll-wake', 'claude', projectPath);
    continuityService.putPolicy('session-poll-wake', { mode: 'wait', maxWaitSeconds: 3600 });
    const source = runService.create({
      source: 'chat',
      projectId: project.project_id,
      appSessionId: 'session-poll-wake',
      provider: 'claude',
    });
    runService.markTerminal(source.run_id, { status: 'succeeded', exitCode: 0 });
    configureContinuityRuntimes({
      claude: async (_command, _options, writer) => {
        (writer as { send: (message: Partial<NormalizedMessage>) => void }).send({
          kind: 'complete', provider: 'claude', exitCode: 0, success: true,
        });
      },
    });
    const recovery = await continuityService.observeRunEvent(
      source.run_id,
      providerMessage('Claude usage limit reached'),
    );
    configureContinuityUsageLoader(async () => usageSnapshot(nowMs, [
      usageRow('claude', nowMs, [usageWindow({ remaining: 12, limit: 100 })]),
    ]));

    await runContinuitySchedulerTick(nowMs);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(continuityRepository.getRecovery(recovery!.recoveryId)?.status, 'completed');
  });
});
