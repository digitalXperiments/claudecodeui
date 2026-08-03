import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { providerAuthService } from '@/modules/providers/services/provider-auth.service.js';
import { sessionSummarizerService } from '@/modules/providers/services/session-summarizer.service.js';

test('summarizeConversation returns null without invoking the SDK when Claude is not installed', async () => {
  const installedMock = mock.method(providerAuthService, 'isProviderInstalled', async () => false);

  try {
    const result = await sessionSummarizerService.summarizeConversation({
      projectPath: '/tmp/project',
      transcriptMarkdown: '## Full transcript\n\n- **User:** hello',
      sourceProvider: 'claude',
      targetProvider: 'codex',
      targetModel: 'gpt-5-codex',
    });

    assert.equal(result, null);
    assert.equal(installedMock.mock.calls.length, 1);
    assert.deepEqual(installedMock.mock.calls[0].arguments, ['claude']);
  } finally {
    installedMock.mock.restore();
  }
});

test('summarizeConversation checks the SOURCE provider, not a fixed one', async () => {
  const installedMock = mock.method(providerAuthService, 'isProviderInstalled', async () => false);

  try {
    await sessionSummarizerService.summarizeConversation({
      projectPath: '/tmp/project',
      transcriptMarkdown: '## Full transcript\n\n- **User:** hello',
      sourceProvider: 'grok',
      targetProvider: 'claude',
      targetModel: 'sonnet',
    });

    assert.deepEqual(installedMock.mock.calls[0].arguments, ['grok']);
  } finally {
    installedMock.mock.restore();
  }
});

test('summarizeConversation returns null for a provider with no one-shot CLI config, without spawning anything', async () => {
  const installedMock = mock.method(providerAuthService, 'isProviderInstalled', async () => true);

  try {
    const result = await sessionSummarizerService.summarizeConversation({
      projectPath: '/tmp/project',
      transcriptMarkdown: '## Full transcript\n\n- **User:** hello',
      sourceProvider: 'cursor',
      targetProvider: 'claude',
      targetModel: 'sonnet',
    });

    assert.equal(result, null);
  } finally {
    installedMock.mock.restore();
  }
});
