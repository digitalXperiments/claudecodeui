import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test, { mock } from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import type { ProviderUsage, ProviderUsageResponse, UsageWindow } from '@/modules/provider-usage/index.js';
import { providerAuthService } from '@/modules/providers/index.js';
import { runService } from '@/modules/runs/index.js';
import { makeScratchDir } from '@/shared/scratch.js';

import { continuityRepository } from '../continuity.repository.js';
import continuityRoutes from '../continuity.routes.js';
import type { ContinuityHealthMatrix, ContinuitySimulation } from '../continuity-health.service.js';
import { getContinuityHealth, simulateRecovery } from '../continuity-health.service.js';
import { configureContinuityUsageLoader } from '../continuity-usage.js';
import { CONTINUITY_PROVIDERS, continuityService } from '../continuity.service.js';
import type { ContinuityRecovery } from '../continuity.types.js';

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

async function withDatabase(callback: (root: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await makeScratchDir('continuity-health-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  configureContinuityUsageLoader(async ({ now }) => usageSnapshot(now, []));
  try {
    await callback(root);
  } finally {
    configureContinuityUsageLoader();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
}

async function withContinuityHttpServer(callback: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(continuityRoutes);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const statusCode = error && typeof error === 'object' && 'statusCode' in error
      ? Number(error.statusCode)
      : 500;
    res.status(statusCode).json({ error: { message: error instanceof Error ? error.message : String(error) } });
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

function mockProviderAuth() {
  return mock.method(providerAuthService, 'getProviderAuthStatus', async (provider: string) => {
    if (provider === 'kilo') throw new Error('Runtime probe failed');
    return {
      installed: provider !== 'omp',
      provider,
      authenticated: provider === 'claude' || provider === 'codex',
      email: null,
      method: provider === 'claude' ? 'oauth' : null,
      ...(provider === 'claude' || provider === 'codex' ? {} : { error: 'Not connected' }),
    };
  });
}

test('the health matrix merges auth status, quota evidence, and recent recovery counts', async () => {
  await withDatabase(async (root) => {
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    const project = projectsDb.createProjectPath(projectPath).project!;
    sessionsDb.createAppSession('session-health', 'claude', projectPath);

    const nowMs = Date.now();
    const resetsAt = new Date(nowMs + 3_600_000).toISOString();
    configureContinuityUsageLoader(async ({ now }) => usageSnapshot(now, [
      usageRow('claude', now, [usageWindow({ remainingRatio: 0.4, resetsAt })], {
        displayName: 'Claude',
        planName: 'Max',
      }),
      usageRow('codex', now, [usageWindow({ used: 100, limit: 100, resetsAt })]),
    ]));

    // One recovery inside the 24h window is attributed to its source provider.
    const run = runService.create({
      source: 'chat',
      projectId: project.project_id,
      appSessionId: 'session-health',
      provider: 'claude',
    });
    continuityRepository.create({
      sourceRunId: run.run_id,
      sessionId: 'session-health',
      sourceProvider: 'claude',
      status: 'waiting',
      action: 'resume',
      fallbackProvider: 'codex',
      detectedReason: 'usage limit',
      retryAt: resetsAt,
      resetTimeSource: 'message',
      attempt: 1,
      maxAttempts: 3,
      policy: {},
    });

    const authMock = mockProviderAuth();
    try {
      const health = await getContinuityHealth(nowMs);
      const byProvider = new Map(health.providers.map((entry) => [entry.provider, entry]));

      assert.equal(health.usageError, null);
      assert.equal(health.generatedAt, new Date(nowMs).toISOString());

      const claude = byProvider.get('claude')!;
      assert.deepEqual(claude, {
        provider: 'claude',
        displayName: 'Claude',
        authenticated: true,
        authError: null,
        installed: true,
        liveUsageSupported: true,
        quota: { status: 'available', remainingRatio: 0.4, resetsAt, planName: 'Max' },
        recoveries24h: 1,
      });

      const codex = byProvider.get('codex')!;
      assert.equal(codex.quota.status, 'exhausted');
      assert.equal(codex.quota.resetsAt, resetsAt);
      assert.equal(codex.quota.remainingRatio, 0);
      assert.equal(codex.recoveries24h, 0);

      // Providers without a usage adapter row stay inconclusive rather than "available".
      const cursor = byProvider.get('cursor')!;
      assert.equal(cursor.quota.status, 'inconclusive');
      assert.equal(cursor.quota.remainingRatio, null);
      assert.equal(cursor.liveUsageSupported, false);
      assert.equal(cursor.authenticated, false);
      assert.equal(cursor.authError, 'Not connected');
      assert.equal(cursor.displayName, 'Cursor');

      // A throwing auth probe degrades to "not installed" instead of failing the matrix.
      const kilo = byProvider.get('kilo')!;
      assert.equal(kilo.installed, false);
      assert.equal(kilo.authenticated, false);
      assert.equal(kilo.authError, 'Runtime probe failed');
      assert.equal(byProvider.get('omp')!.installed, false);
    } finally {
      authMock.mock.restore();
    }
  });
});

test('the health matrix survives a failing usage loader', async () => {
  await withDatabase(async () => {
    configureContinuityUsageLoader(async () => {
      throw new Error('usage backend offline');
    });
    const authMock = mockProviderAuth();
    try {
      const health = await getContinuityHealth();
      assert.equal(health.usageError, 'usage backend offline');
      assert.equal(health.usageFetchedAt, null);
      assert.ok(health.providers.every((entry) => entry.quota.status === 'inconclusive'));
      assert.equal(health.providers.find((entry) => entry.provider === 'claude')?.authenticated, true);
    } finally {
      authMock.mock.restore();
    }
  });
});

test('simulateRecovery replays scheduler decisions without writing recoveries', async () => {
  await withDatabase(async (root) => {
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    projectsDb.createProjectPath(projectPath);
    sessionsDb.createAppSession('session-sim', 'claude', projectPath);
    continuityService.putPolicy('session-sim', {
      mode: 'wait',
      fallbackProviders: ['claude', 'codex'],
      maxWaitSeconds: 600,
      maxAttempts: 2,
      unknownResetDelaySeconds: 900,
    });

    const nowMs = Date.parse('2026-01-01T00:00:00.000Z');
    const retryAt = new Date(nowMs + 1_800_000).toISOString();

    const waiting = await simulateRecovery({
      sessionId: 'session-sim',
      sourceProvider: 'claude',
      retryAt,
      detectedReason: 'Claude usage limit reached',
    }, nowMs);
    assert.equal(waiting.action, 'resume');
    assert.equal(waiting.status, 'waiting');
    assert.equal(waiting.resetTimeSource, 'message');
    assert.equal(waiting.policySource, 'session');
    // The 15s reset jitter is applied on top of the reported reset time.
    assert.equal(waiting.retryAt, new Date(Date.parse(retryAt) + 15_000).toISOString());
    assert.equal(waiting.waitSeconds, 1815);
    assert.equal(waiting.fallbackProvider, 'codex');
    assert.deepEqual(waiting.trace.map((entry) => entry.step), [
      'policy', 'fallback', 'attempts', 'reset', 'wait', 'decision',
    ]);

    // smart hands off once the projected wait passes maxWaitSeconds.
    const smart = await simulateRecovery({
      sessionId: 'session-sim',
      policy: { mode: 'smart' },
      sourceProvider: 'claude',
      retryAt,
    }, nowMs);
    assert.equal(smart.action, 'handoff');
    assert.equal(smart.status, 'waiting');
    assert.equal(smart.policySource, 'override');
    assert.equal(smart.fallbackProvider, 'codex');
    assert.equal(smart.retryAt, new Date(nowMs).toISOString());
    assert.equal(smart.waitSeconds, 0);

    // smart still resumes when the wait fits inside the budget.
    const shortWait = await simulateRecovery({
      sessionId: 'session-sim',
      policy: { mode: 'smart' },
      sourceProvider: 'claude',
      retryAt: new Date(nowMs + 60_000).toISOString(),
    }, nowMs);
    assert.equal(shortWait.action, 'resume');

    // switch without a usable fallback needs a human.
    const stranded = await simulateRecovery({
      sessionId: 'session-sim',
      policy: { mode: 'switch', fallbackProviders: ['claude'] },
      sourceProvider: 'claude',
      retryAt,
    }, nowMs);
    assert.equal(stranded.action, 'handoff');
    assert.equal(stranded.status, 'needs_attention');
    assert.equal(stranded.retryAt, null);
    assert.equal(stranded.fallbackProvider, null);

    const asked = await simulateRecovery({
      sessionId: 'session-sim',
      policy: { mode: 'ask' },
      sourceProvider: 'claude',
      retryAt,
    }, nowMs);
    assert.equal(asked.status, 'needs_attention');
    assert.equal(asked.retryAt, null);

    const exhaustedAttempts = await simulateRecovery({
      sessionId: 'session-sim',
      sourceProvider: 'claude',
      retryAt,
      attempt: 3,
    }, nowMs);
    assert.equal(exhaustedAttempts.status, 'needs_attention');
    assert.equal(exhaustedAttempts.attempt, 3);
    assert.equal(exhaustedAttempts.retryAt, null);

    const off = await simulateRecovery({
      sessionId: 'session-sim',
      policy: { mode: 'off' },
      sourceProvider: 'claude',
      retryAt,
    }, nowMs);
    assert.equal(off.action, 'none');
    assert.equal(off.status, 'skipped');
    assert.equal(off.waitSeconds, 0);

    assert.equal(continuityRepository.getLatestForSession('session-sim'), null);
  });
});

test('simulateRecovery consults live usage when the limit message has no reset time', async () => {
  await withDatabase(async (root) => {
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    projectsDb.createProjectPath(projectPath);
    sessionsDb.createAppSession('session-sim-usage', 'claude', projectPath);
    continuityService.putPolicy('session-sim-usage', { mode: 'wait', unknownResetDelaySeconds: 900 });

    const nowMs = Date.now();
    const resetsAt = new Date(nowMs + 7_200_000).toISOString();
    configureContinuityUsageLoader(async ({ now }) => usageSnapshot(now, [
      usageRow('claude', now, [usageWindow({ remaining: 0, resetsAt })]),
    ]));

    const fromUsage = await simulateRecovery({
      sessionId: 'session-sim-usage',
      sourceProvider: 'claude',
    }, nowMs);
    assert.equal(fromUsage.resetTimeSource, 'provider');
    assert.equal(fromUsage.retryAt, new Date(Date.parse(resetsAt) + 15_000).toISOString());

    // A provider with no live usage support falls back to the configured delay,
    // and an unparseable reset time is treated as no signal at all.
    for (const retryAt of [undefined, 'later today']) {
      const fromFallback = await simulateRecovery({
        sessionId: 'session-sim-usage',
        sourceProvider: 'cursor',
        retryAt,
      }, nowMs);
      assert.equal(fromFallback.resetTimeSource, 'fallback');
      assert.equal(fromFallback.waitSeconds, 900);
    }
  });
});

test('continuity routes expose health, history, and simulation', async () => {
  await withDatabase(async (root) => {
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    const project = projectsDb.createProjectPath(projectPath).project!;
    sessionsDb.createAppSession('session-routes', 'claude', projectPath);
    continuityService.putPolicy('session-routes', { mode: 'switch', fallbackProviders: ['codex'] });

    const run = runService.create({
      source: 'chat',
      projectId: project.project_id,
      appSessionId: 'session-routes',
      provider: 'claude',
    });
    const stored = continuityRepository.create({
      sourceRunId: run.run_id,
      sessionId: 'session-routes',
      sourceProvider: 'claude',
      status: 'waiting',
      action: 'handoff',
      fallbackProvider: 'codex',
      detectedReason: 'usage limit',
      retryAt: new Date().toISOString(),
      resetTimeSource: 'message',
      attempt: 1,
      maxAttempts: 3,
      policy: {},
    });

    const authMock = mockProviderAuth();
    try {
      await withContinuityHttpServer(async (baseUrl) => {
        const health = await (await fetch(`${baseUrl}/continuity/health`)).json() as {
          success: boolean;
          data: ContinuityHealthMatrix;
        };
        assert.equal(health.success, true);
        assert.equal(health.data.providers.length, CONTINUITY_PROVIDERS.length);
        assert.equal(health.data.providers.find((entry) => entry.provider === 'claude')?.recoveries24h, 1);

        const history = await (await fetch(`${baseUrl}/continuity/history?limit=5`)).json() as {
          data: { limit: number; recoveries: ContinuityRecovery[] };
        };
        assert.equal(history.data.limit, 5);
        assert.deepEqual(
          history.data.recoveries.map((entry) => entry.recoveryId),
          [stored.recoveryId],
        );

        const simulateResponse = await fetch(`${baseUrl}/continuity/simulate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: 'session-routes',
            sourceProvider: 'claude',
            retryAt: new Date(Date.now() + 600_000).toISOString(),
          }),
        });
        const simulated = await simulateResponse.json() as { data: { simulation: ContinuitySimulation } };
        assert.equal(simulateResponse.status, 200);
        assert.equal(simulated.data.simulation.action, 'handoff');
        assert.equal(simulated.data.simulation.fallbackProvider, 'codex');
        assert.ok(simulated.data.simulation.trace.length > 0);

        const rejected = await fetch(`${baseUrl}/continuity/simulate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: 'session-routes', sourceProvider: 'nope' }),
        });
        assert.equal(rejected.status, 400);

        const missingSession = await fetch(`${baseUrl}/continuity/simulate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: 'unknown-session', sourceProvider: 'claude' }),
        });
        assert.equal(missingSession.status, 404);

        // The simulation must not persist anything.
        assert.equal(continuityRepository.listRecentRecoveries(10).length, 1);
      });
    } finally {
      authMock.mock.restore();
    }
  });
});
