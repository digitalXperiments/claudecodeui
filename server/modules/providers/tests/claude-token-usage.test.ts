import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  readClaudeRunTokenUsage,
  readClaudeSessionTokenUsage,
} from '@/modules/providers/index.js';
import { makeScratchDir } from '@/shared/scratch.js';

function assistant(timestamp: string, input: number, cacheRead: number, cacheWrite: number, output: number) {
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    message: {
      model: 'claude-sonnet-5',
      usage: {
        input_tokens: input,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheWrite,
        output_tokens: output,
      },
    },
  });
}

test('Claude JSONL usage keeps cumulative cache splits aligned with cumulative input', async () => {
  const directory = await makeScratchDir('claude-token-usage-');
  try {
    const jsonlPath = path.join(directory, 'session.jsonl');
    await writeFile(
      jsonlPath,
      [
        assistant('2026-07-01T09:00:00.000Z', 10, 90, 5, 2),
        assistant('2026-07-01T10:05:00.000Z', 20, 180, 10, 4),
        assistant('2026-07-01T10:10:00.000Z', 30, 270, 15, 6),
      ].join('\n'),
      'utf8',
    );

    const session = readClaudeSessionTokenUsage(jsonlPath);
    assert.equal(session.billedInputTokens, 630);
    assert.equal(session.billedOutputTokens, 12);
    assert.equal(session.cacheReadTokens, 540);
    assert.equal(session.cacheCreationTokens, 30);

    const run = readClaudeRunTokenUsage(
      jsonlPath,
      '2026-07-01T10:00:00.000Z',
      '2026-07-01T10:15:00.000Z',
    );
    assert.ok(run);
    assert.equal(run.billedInputTokens, 525);
    assert.equal(run.billedOutputTokens, 10);
    assert.equal(run.cacheReadTokens, 450);
    assert.equal(run.cacheCreationTokens, 25);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
