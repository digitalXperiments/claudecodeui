import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import {
  buildSlackSectionInput,
} from '@/modules/mission-control/action-centre-seed.js';
import { configureMissionControlRuntimes } from '@/modules/mission-control/mission-control-agent.service.js';
import { missionControlDb } from '@/modules/mission-control/mission-control.repository.js';
import {
  applyItemAction,
  runSectionProduce,
} from '@/modules/mission-control/mission-control-runner.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { AnyRecord } from '@/shared/types.js';

type Writer = {
  send: (event: AnyRecord) => void;
  sendComplete: (event: AnyRecord) => void;
};

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempRoot = path.join(process.cwd(), 'tmp', 'cloudcli');
  await mkdir(tempRoot, { recursive: true });
  const tempDirectory = await mkdtemp(path.join(tempRoot, 'mc-slack-reply-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    chatRunRegistry.clearAll();
    configureMissionControlRuntimes({});
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function seedSlackSection() {
  return missionControlDb.createSection({
    ...buildSlackSectionInput(),
    title: 'Slack Messages',
  });
}

function slackDraft(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Basil in DM: status update',
    summary: 'Basil needs a status update.',
    body: {
      source: 'slack',
      channelId: 'D123',
      channelName: 'DM with Basil',
      messageTs: '1710000000.000001',
      threadTs: null,
      sender: 'Basil',
      timestamp: '2026-09-02T15:00:00.000Z',
      snippet: 'Did we finish the update?',
      link: null,
      directedToMe: true,
      needsMyReply: true,
      addressingEvidence: 'The DM is addressed to me and asks for a status update.',
      whyActionable: 'The message asks for a status update.',
      suggestedNextStep: 'Confirm the current status.',
      ...overrides,
    },
    dedupeKey: 'slack:D123:1710000000.000001',
    confidence: 0.9,
  };
}

function stubClaudeRuntime(outputs: string[]): { prompts: string[]; options: AnyRecord[] } {
  const prompts: string[] = [];
  const options: AnyRecord[] = [];
  let call = 0;
  configureMissionControlRuntimes({
    claude: async (command: string, runtimeOptions: AnyRecord, writer: unknown) => {
      prompts.push(command);
      options.push(runtimeOptions);
      const output = outputs[call] ?? outputs[outputs.length - 1] ?? '{}';
      call += 1;
      const w = writer as Writer;
      w.send({ kind: 'text', provider: 'claude', content: output });
      w.sendComplete({ exitCode: 0 });
    },
  });
  return { prompts, options };
}

test('Slack produce keeps reply drafting behind an explicit user action', async () => {
  await withIsolatedDatabase(async () => {
    const section = seedSlackSection();
    const runtime = stubClaudeRuntime([
      JSON.stringify([slackDraft({
        draft: 'Yes — the update is complete and today’s refresh ran on the fixed version.',
        draftedAt: '2026-09-02T15:01:00.000Z',
      })]),
    ]);

    const result = await runSectionProduce(section.section_id);

    assert.equal(result.created, 1);
    assert.equal(runtime.prompts.length, 1);
    assert.equal(result.items[0]?.body.draft, undefined);
    assert.equal(result.items[0]?.status, 'pending');
  });
});

test('Slack draft reply uses operator context and leaves the item pending', async () => {
  await withIsolatedDatabase(async () => {
    const section = seedSlackSection();
    const runtime = stubClaudeRuntime([
      JSON.stringify([slackDraft()]),
      JSON.stringify({
        draft: 'I’m checking this now and will confirm the result shortly.',
        draftedAt: '2026-09-02T15:01:00.000Z',
      }),
    ]);

    const result = await runSectionProduce(section.section_id);
    const item = result.items[0];

    assert.equal(result.created, 1);
    assert.equal(runtime.prompts.length, 1);
    assert.equal(item?.status, 'pending');
    assert.equal(item?.body.draft, undefined);

    const drafted = await applyItemAction(item!.item_id, 'draft_reply', {
      ...item!.body,
      operatorContext: 'Keep it concise, confirm the current status, and mention the latest refresh.',
    });

    assert.equal(drafted?.status, 'pending');
    assert.equal(drafted?.body.draft, 'I’m checking this now and will confirm the result shortly.');
    assert.match(runtime.prompts[1] ?? '', /action "draft_reply"/);
    assert.match(runtime.prompts[1] ?? '', /relevant Obsidian notes/i);
    assert.match(runtime.prompts[1] ?? '', /Keep it concise, confirm the current status/);
    assert.deepEqual(runtime.options[1]?.mcpServers, ['claude.ai Slack', 'obsidian']);
  });
});

test('Slack send reply prompt carries the exact reviewed draft', async () => {
  await withIsolatedDatabase(async () => {
    const section = seedSlackSection();
    const item = missionControlDb.insertItemIfNew(section, slackDraft({
      draft: 'This is the reviewed reply. Send these exact words.',
      draftedAt: '2026-09-02T15:01:00.000Z',
    }));
    assert.ok(item);
    const runtime = stubClaudeRuntime([
      JSON.stringify({
        sent: true,
        messageTs: '1710000000.000002',
        sentAt: '2026-09-02T15:02:00.000Z',
      }),
    ]);

    const resolved = await applyItemAction(item.item_id, 'send_reply');

    assert.equal(resolved?.status, 'resolved');
    assert.match(runtime.prompts[0] ?? '', /This is the reviewed reply\. Send these exact words\./);
    assert.match(runtime.prompts[0] ?? '', /exact reviewed text in body\.draft/i);
    assert.doesNotMatch(runtime.prompts[0] ?? '', /otherwise compose one/i);
  });
});

test('Slack produce excludes messages not directed to me or not needing my reply', async () => {
  await withIsolatedDatabase(async () => {
    const section = seedSlackSection();
    const runtime = stubClaudeRuntime([
      JSON.stringify([
        slackDraft({
          title: 'Basil in DM: status update',
          directedToMe: true,
          needsMyReply: true,
          draft: 'The one item that should remain.',
          draftedAt: '2026-09-02T15:01:00.000Z',
        }),
        slackDraft({
          title: 'Channel chatter: project update',
          directedToMe: false,
          needsMyReply: true,
          draft: 'This should not be queued.',
          draftedAt: '2026-09-02T15:01:00.000Z',
        }),
        slackDraft({
          title: 'FYI: deployment complete',
          directedToMe: true,
          needsMyReply: false,
          draft: 'This should also not be queued.',
          draftedAt: '2026-09-02T15:01:00.000Z',
        }),
      ]),
    ]);

    const result = await runSectionProduce(section.section_id);

    assert.equal(result.created, 1);
    assert.equal(result.items[0]?.body.draft, undefined);
    assert.equal(runtime.prompts.length, 1);
  });
});

test('Slack produce treats an all-filtered result as a normal no-op', async () => {
  await withIsolatedDatabase(async () => {
    const section = seedSlackSection();
    stubClaudeRuntime([
      JSON.stringify([slackDraft({ directedToMe: false, needsMyReply: false })]),
    ]);

    const result = await runSectionProduce(section.section_id);

    assert.equal(result.created, 0);
    assert.equal(result.error, undefined);
    assert.match(result.message, /no Slack messages addressed to you/i);
  });
});

test('disabled sections do not run manually', async () => {
  await withIsolatedDatabase(async () => {
    const section = missionControlDb.createSection({
      ...buildSlackSectionInput(),
      title: 'Disabled Slack',
      enabled: false,
    });
    const runtime = stubClaudeRuntime([JSON.stringify([slackDraft()])]);

    const result = await runSectionProduce(section.section_id);

    assert.equal(result.created, 0);
    assert.match(result.message, /section is disabled/i);
    assert.equal(runtime.prompts.length, 0);
  });
});
