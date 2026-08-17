import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { makeScratchDir } from '@/shared/scratch.js';
import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';
import { interruptsDb, interruptsService } from '@/modules/interrupt-queue/index.js';
import { applyItemAction, missionControlDb } from '@/modules/mission-control/index.js';
import { runService } from '@/modules/runs/index.js';

async function withDatabase(fn: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await makeScratchDir('interrupts-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'interrupts.db');
  await initializeDatabase();
  try { await fn(); } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(directory, { recursive: true, force: true });
  }
}

test('Mission Control actions close linked interrupts and stale approvals stay hidden', async () => {
  await withDatabase(async () => {
    const section = missionControlDb.createSection({
      title: 'Jira Drafts',
      mode: 'review',
      provider: 'claude',
      resolve_prompt: '',
    });
    const item = missionControlDb.insertItemIfNew(section, {
      title: 'Approved draft',
      summary: '',
      body: {},
      dedupeKey: 'jira-approved-1',
    });
    assert.ok(item);

    const linkedInterrupt = interruptsService.create({
      kind: 'approval_pending',
      title: 'Jira Drafts: review needed',
      meta: { itemId: item.item_id },
      dedupeKey: `mc_item:${item.item_id}`,
    });

    const dismissed = await applyItemAction(item.item_id, 'deny');
    assert.equal(dismissed?.status, 'dismissed');
    assert.equal(interruptsDb.get(linkedInterrupt.interrupt_id)?.status, 'resolved');
    assert.equal(interruptsService.countOpen(), 0);

    const staleItem = missionControlDb.insertItemIfNew(section, {
      title: 'Previously approved draft',
      summary: '',
      body: {},
      dedupeKey: 'jira-approved-2',
    });
    assert.ok(staleItem);
    const staleInterrupt = interruptsService.create({
      kind: 'approval_pending',
      title: 'Jira Drafts: review needed',
      meta: { itemId: staleItem.item_id },
      dedupeKey: `mc_item:${staleItem.item_id}`,
    });
    missionControlDb.setItemStatus(staleItem.item_id, 'resolved');

    assert.equal(interruptsDb.get(staleInterrupt.interrupt_id)?.status, 'open');
    assert.equal(interruptsService.list().some((i) => i.interrupt_id === staleInterrupt.interrupt_id), false);
    assert.equal(interruptsService.countOpen(), 0);

    const swept = interruptsService.sweep();
    assert.equal(swept.resolved, 1);
    assert.equal(interruptsDb.get(staleInterrupt.interrupt_id)?.status, 'resolved');
    assert.equal(interruptsDb.get(staleInterrupt.interrupt_id)?.resolution, 'mc_item_terminal');
  });
});

test('Needs you scope excludes operational telemetry from the list and badge', async () => {
  await withDatabase(() => {
    const permission = interruptsService.create({
      kind: 'permission_pending',
      title: 'Permission required',
      actions: [{ id: 'approve_permission', label: 'Approve' }],
    });
    const approval = interruptsService.create({
      kind: 'approval_pending',
      title: 'Approval required',
      actions: [{ id: 'dismiss', label: 'Dismiss' }],
    });
    interruptsService.create({ kind: 'run_stuck', title: 'Stuck run' });
    interruptsService.create({ kind: 'run_failed', title: 'Failed run' });
    interruptsService.create({ kind: 'ci_failed', title: 'CI failed' });

    const attention = interruptsService.list({ attentionOnly: true });
    assert.deepEqual(
      attention.map((item) => item.interrupt_id).sort(),
      [permission.interrupt_id, approval.interrupt_id].sort(),
    );
    assert.equal(interruptsService.countOpen(undefined, true), 2);
    assert.equal(interruptsService.countOpen(), 5);

    const spend = interruptsService.create({ kind: 'spend_cap', title: 'Spend cap' });
    const shift = interruptsService.create({ kind: 'shift_report', title: 'Shift report' });
    const attentionWithGovernor = interruptsService.list({ attentionOnly: true });
    assert.equal(
      attentionWithGovernor.some((item) => item.interrupt_id === spend.interrupt_id),
      true,
    );
    assert.equal(
      attentionWithGovernor.some((item) => item.interrupt_id === shift.interrupt_id),
      true,
    );
  });
});

test('sweep retires stuck cards for terminal runs and orphaned approvals', async () => {
  await withDatabase(() => {
    const run = runService.create({ source: 'chat', title: 'Finished elsewhere' });
    const stuck = interruptsService.create({
      kind: 'run_stuck',
      title: 'Run stuck',
      runId: run.run_id,
      dedupeKey: `run_stuck:${run.run_id}`,
    });
    const orphanedApproval = interruptsService.create({
      kind: 'approval_pending',
      title: 'Deleted draft approval',
      meta: { itemId: 'mc_item_missing' },
      dedupeKey: 'mc_item:mc_item_missing',
    });

    // Simulate state left behind by an older process that never ran the
    // terminal hook; boot maintenance must reconcile it from durable state.
    getConnection()
      .prepare(`UPDATE agent_runs SET status = 'succeeded' WHERE run_id = ?`)
      .run(run.run_id);

    const result = interruptsService.sweep();
    assert.equal(result.resolved, 2);
    assert.equal(interruptsService.get(stuck.interrupt_id)?.resolution, 'run_terminal');
    assert.equal(interruptsService.get(orphanedApproval.interrupt_id)?.resolution, 'mc_item_missing');
    assert.equal(interruptsService.countOpen(), 0);
  });
});

test('interrupts dedupe, prioritize, snooze, and resolve actions', async () => {
  await withDatabase(() => {
    const first = interruptsService.create({
      kind: 'run_failed',
      title: 'Failed run',
      runId: 'run_1',
      priority: 30,
      actions: [{ id: 'dismiss', label: 'Dismiss' }],
      dedupeKey: 'run_failed:run_1',
    });
    const refreshed = interruptsService.create({
      kind: 'run_failed',
      title: 'Failed run again',
      runId: 'run_1',
      priority: 30,
      dedupeKey: 'run_failed:run_1',
    });
    assert.equal(refreshed.interrupt_id, first.interrupt_id);
    assert.equal(interruptsService.countOpen(), 1);
    const until = new Date(Date.now() + 60_000).toISOString();
    interruptsService.snooze(first.interrupt_id, until, 'user-1');
    assert.equal(interruptsService.countOpen(), 0);
    interruptsDb.resolve(first.interrupt_id, 'dismissed', 'user-1', 'dismiss');
    assert.equal(interruptsService.countOpen(), 0);

    // Resolving releases the active-key uniqueness slot; the next lifecycle
    // gets a fresh row, while duplicate creates within that lifecycle converge.
    const reopened = interruptsService.create({
      kind: 'run_failed',
      title: 'Failed again later',
      runId: 'run_1',
      dedupeKey: 'run_failed:run_1',
    });
    const reopenedDuplicate = interruptsService.create({
      kind: 'run_failed',
      title: 'Same later failure',
      runId: 'run_1',
      dedupeKey: 'run_failed:run_1',
    });
    assert.notEqual(reopened.interrupt_id, first.interrupt_id);
    assert.equal(reopenedDuplicate.interrupt_id, reopened.interrupt_id);
    assert.equal(interruptsService.countOpen(), 1);
  });
});

test('approve permission and abort run actions call their server handlers', async () => {
  await withDatabase(() => {
    let resolved: { requestId: string; allow: boolean } | null = null;
    interruptsService.configurePermissionResolver((requestId, decision) => { resolved = { requestId, allow: decision.allow }; });
    const run = runService.create({ source: 'chat', title: 'Waiting run' });
    const permission = interruptsService.create({
      kind: 'permission_pending',
      title: 'Permission',
      runId: run.run_id,
      actions: [{ id: 'approve_permission', label: 'Approve' }],
      meta: { requestId: 'req-1' },
    });
    interruptsService.act(permission.interrupt_id, { key: 'approve_permission', actor: 'u' });
    assert.deepEqual(resolved, { requestId: 'req-1', allow: true });
    assert.equal(interruptsService.get(permission.interrupt_id)?.status, 'resolved');

    const failed = interruptsService.create({ kind: 'run_failed', title: 'Abort me', runId: run.run_id });
    interruptsService.act(failed.interrupt_id, { key: 'abort_run' });
    assert.equal(runService.get(run.run_id)?.status, 'aborted');
    interruptsService.configurePermissionResolver(null);
  });
});

test('failed swarm actions remain open instead of acknowledging a side effect that did not happen', async () => {
  await withDatabase(async () => {
    const interrupt = interruptsService.create({
      kind: 'approval_pending',
      title: 'Missing swarm approval',
      actions: [{ id: 'approve_swarm', label: 'Approve' }],
      meta: { swarmId: 'swarm_missing' },
    });

    await assert.rejects(
      interruptsService.actAndWait(interrupt.interrupt_id, {
        key: 'approve_swarm',
        actor: 'user-1',
      }),
      /Swarm not found/,
    );
    assert.equal(interruptsService.get(interrupt.interrupt_id)?.status, 'open');
  });
});
