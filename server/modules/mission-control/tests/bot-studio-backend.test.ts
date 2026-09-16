import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import {
  buildRuntimeOptions,
  buildToolPolicyAdvisoryPrompt,
} from '@/modules/mission-control/mission-control-agent.service.js';
import { missionControlDb } from '@/modules/mission-control/mission-control.repository.js';
import missionControlRoutes from '@/modules/mission-control/mission-control.routes.js';
import {
  getMissionControlScheduledJobCount,
  startMissionControlScheduler,
  stopMissionControlScheduler,
} from '@/modules/mission-control/mission-control-scheduler.service.js';
import { runsDb } from '@/modules/runs/index.js';
import type { AnyRecord } from '@/shared/types.js';

type RouteResponse = { statusCode: number; body: Record<string, unknown> };

function invokeMissionControlRoute(
  method: string,
  url: string,
  body: Record<string, unknown> = {},
): Promise<RouteResponse> {
  return new Promise((resolve, reject) => {
    const req = { method, url, originalUrl: url, body, query: {} };
    const response: RouteResponse = { statusCode: 200, body: {} };
    const res = {
      status(code: number) {
        response.statusCode = code;
        return res;
      },
      json(payload: Record<string, unknown>) {
        response.body = payload;
        resolve(response);
        return res;
      },
      send(payload: Record<string, unknown>) {
        response.body = payload;
        resolve(response);
        return res;
      },
      end() {
        resolve(response);
        return res;
      },
    };
    (missionControlRoutes as unknown as {
      handle: (request: unknown, response: unknown, next: (error?: unknown) => void) => void;
    }).handle(req, res, (error: unknown) => {
      if (error) reject(error);
      else resolve(response);
    });
  });
}

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'mc-bot-studio-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'bot-studio.db');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('MCP policy translates allow/deny and preserves wildcard fallback', async () => {
  await withIsolatedDatabase(() => {
    const section = missionControlDb.createSection({
      title: 'Policy test',
      produce_tools: ['my-server', 'unrestricted'],
      tool_policy: { 'my-server': { read: 'allow', write: 'deny', send: 'ask' } },
    });
    const options = buildRuntimeOptions(section, section.produce_tools) as AnyRecord;
    const settings = options.toolsSettings as AnyRecord;
    assert.ok((settings.allowedTools as string[]).includes('mcp__my_server__read'));
    assert.ok((settings.disallowedTools as string[]).includes('mcp__my_server__write'));
    assert.ok(!(settings.allowedTools as string[]).includes('mcp__my_server__*'));
    assert.ok((settings.allowedTools as string[]).includes('mcp__unrestricted__*'));
    assert.ok(!(settings.allowedTools as string[]).includes('mcp__my_server__send'));
  });
});

test('restricted policy downgrades Claude bypass permissions', async () => {
  await withIsolatedDatabase(() => {
    const section = missionControlDb.createSection({
      title: 'Held policy test',
      produce_tools: ['my-server'],
      permission_mode: 'bypassPermissions',
      tool_policy: { 'my-server': { read: 'allow', send: 'ask' } },
    });
    const options = buildRuntimeOptions(section, section.produce_tools) as AnyRecord;
    const settings = options.toolsSettings as AnyRecord;
    assert.equal(options.permissionMode, 'default');
    assert.equal(settings.skipPermissions, false);
    assert.ok(!(settings.allowedTools as string[]).includes('mcp__my_server__send'));
  });
});

test('unsupported providers receive a compact advisory policy block', async () => {
  await withIsolatedDatabase(() => {
    const section = missionControlDb.createSection({
      title: 'Advisory test',
      provider: 'codex',
      produce_tools: ['my-server'],
      tool_policy: { 'my-server': { write: 'deny', send: 'ask' } },
    });
    const prompt = buildToolPolicyAdvisoryPrompt(section, section.produce_tools);
    assert.match(prompt, /TOOL POLICY \(advisory\)/);
    assert.match(prompt, /mcp__my_server__write/);
    assert.match(prompt, /mcp__my_server__send/);
  });
});

test('run history, roster summary, and bulk enabled updates stay bounded and shaped', async () => {
  await withIsolatedDatabase(() => {
    const section = missionControlDb.createSection({ title: 'Roster test' });
    const item = missionControlDb.insertItemIfNew(section, {
      title: 'Pending item', summary: '', body: {}, dedupeKey: 'pending',
    });
    assert.ok(item);
    const resolved = missionControlDb.insertItemIfNew(section, {
      title: 'Resolved item', summary: '', body: {}, dedupeKey: 'resolved',
    });
    assert.ok(resolved);
    missionControlDb.setItemStatus(resolved.item_id, 'resolved');
    const run = runsDb.create({
      source: 'mission_control',
      sourceRef: item.item_id,
      trigger: 'manual',
      meta: { section_id: section.section_id, item_id: item.item_id, phase: 'resolve' },
    });
    runsDb.markTerminal(run.run_id, { status: 'succeeded' });
    const history = runsDb.listBySourceRefs('mission_control', [section.section_id, item.item_id], 50);
    assert.equal(history.length, 1);
    assert.equal(history[0]?.meta.phase, 'resolve');
    const summary = missionControlDb.getSummary();
    assert.equal(summary.pendingCount, 1);
    assert.equal(summary.sectionCount, 1);
    assert.deepEqual(summary.sections[0], {
      section_id: section.section_id,
      pending: 1,
      failed: 0,
      resolved_today: 1,
      last_run_at: null,
      last_error: null,
    });
    assert.equal(missionControlDb.updateSectionsEnabled('all', false), 1);
    assert.equal(missionControlDb.getSection(section.section_id)?.enabled, false);
  });
});

test('mission control routes expose compatible summary, runs, and bulk responses', async () => {
  await withIsolatedDatabase(async () => {
    const section = missionControlDb.createSection({
      title: 'Route test',
      schedule_cron: '* * * * *',
    });
    const item = missionControlDb.insertItemIfNew(section, {
      title: 'Route item', summary: 'summary', body: {}, dedupeKey: 'route-item',
    });
    assert.ok(item);
    const run = runsDb.create({
      source: 'mission_control', sourceRef: item.item_id, trigger: 'manual',
      meta: { section_id: section.section_id, item_id: item.item_id, phase: 'resolve' },
    });
    runsDb.markTerminal(run.run_id, { status: 'succeeded' });

    startMissionControlScheduler();
    try {
      assert.equal(getMissionControlScheduledJobCount(), 1);
      const summary = await invokeMissionControlRoute('GET', '/summary');
      assert.equal(summary.statusCode, 200);
      assert.equal(summary.body.pendingCount, 1);
      assert.equal(summary.body.sectionCount, 1);
      assert.ok(Array.isArray(summary.body.sections));

      const history = await invokeMissionControlRoute(
        'GET', `/sections/${section.section_id}/runs?limit=50`,
      );
      assert.equal(history.statusCode, 200);
      const runs = history.body.runs as Array<Record<string, unknown>>;
      assert.equal(runs.length, 1);
      assert.equal(runs[0]?.kind, 'resolve');
      assert.equal(runs[0]?.item_id, item.item_id);

      const bulk = await invokeMissionControlRoute('POST', '/sections/bulk', {
        ids: [section.section_id], patch: { enabled: false },
      });
      assert.equal(bulk.statusCode, 200);
      assert.equal(bulk.body.updated, 1);
      assert.equal(missionControlDb.getSection(section.section_id)?.enabled, false);
      assert.equal(getMissionControlScheduledJobCount(), 0);
    } finally {
      stopMissionControlScheduler();
    }
  });
});
