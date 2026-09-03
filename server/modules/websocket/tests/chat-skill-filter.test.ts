import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import {
  filterSkillBodyEvent,
  isSkillMarkdownPath,
  SKILL_BODY_REDACTION,
} from '@/modules/websocket/services/chat-stream-filter.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import type { NormalizedMessage } from '@/shared/types.js';

class FakeConnection {
  readyState = 1;
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

const SKILL_BODY = [
  '---',
  'name: delegated-work',
  '---',
  '',
  'Never expose this playbook to the chat transcript.',
].join('\n');

function message(fields: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    id: 'message-1',
    sessionId: 'provider-session',
    timestamp: '2026-09-02T00:00:00.000Z',
    provider: 'claude',
    kind: 'text',
    ...fields,
  };
}

test('skill markdown paths are recognized across provider path formats', () => {
  assert.equal(isSkillMarkdownPath('/home/user/.agents/skills/delegated/SKILL.md'), true);
  assert.equal(isSkillMarkdownPath('C:\\Users\\agent\\skills\\delegated\\skill.md'), true);
  assert.equal(isSkillMarkdownPath('/workspace/SKILL.md?line=1'), true);
  assert.equal(isSkillMarkdownPath('/workspace/skill.md.backup'), false);
  assert.equal(isSkillMarkdownPath('/workspace/README.md'), false);
});

test('read results for SKILL.md are redacted while ordinary reads remain unchanged', () => {
  const skillReadToolIds = new Set<string>();
  const read = message({
    kind: 'tool_use',
    toolName: 'Read',
    toolInput: { file_path: '/home/user/.claude/skills/delegated/SKILL.md' },
    toolId: 'read-skill-1',
  });
  const ordinaryRead = message({
    kind: 'tool_use',
    toolName: 'Read',
    toolInput: { file_path: '/workspace/src/index.ts' },
    toolId: 'read-code-1',
  });

  assert.equal(filterSkillBodyEvent(read, skillReadToolIds), read);
  assert.equal(filterSkillBodyEvent(ordinaryRead, skillReadToolIds), ordinaryRead);

  const result = message({
    kind: 'tool_result',
    toolId: 'read-skill-1',
    content: SKILL_BODY,
    toolUseResult: { content: SKILL_BODY },
  });
  const filtered = filterSkillBodyEvent(result, skillReadToolIds);

  assert.equal(filtered?.content, SKILL_BODY_REDACTION);
  assert.equal('toolUseResult' in (filtered ?? {}), false);
  assert.equal(JSON.stringify(filtered).includes(SKILL_BODY), false);

  const ordinaryResult = message({
    kind: 'tool_result',
    toolId: 'read-code-1',
    content: 'export const answer = 42;',
  });
  assert.equal(filterSkillBodyEvent(ordinaryResult, skillReadToolIds), ordinaryResult);
});

test('injected skill body text is dropped without consuming a sequence number', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'chat-skill-filter-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    sessionsDb.createAppSession('skill-filter-run', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'skill-filter-run',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send(message({
      kind: 'tool_use',
      toolName: 'Read',
      toolInput: { file_path: '/home/user/.claude/skills/delegated/SKILL.md' },
      toolId: 'read-skill-live-1',
    }));
    run.writer.send(message({
      kind: 'tool_result',
      toolId: 'read-skill-live-1',
      content: SKILL_BODY,
    }));
    run.writer.send(message({
      kind: 'text',
      role: 'user',
      content: 'Base directory for this skill: /home/user/.claude/skills/delegated\n\n' + SKILL_BODY,
    }));
    run.writer.send(message({ kind: 'stream_delta', content: 'visible response' }));

    assert.deepEqual(connection.frames.map((frame) => frame.content), [undefined, SKILL_BODY_REDACTION, 'visible response']);
    assert.equal(connection.frames[1]?.seq, 2);
    assert.equal(JSON.stringify(connection.frames[1]).includes(SKILL_BODY), false);
    assert.deepEqual(
      chatRunRegistry.replayEvents('skill-filter-run', 0).map((event) => event.content),
      [undefined, SKILL_BODY_REDACTION, 'visible response'],
    );
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
