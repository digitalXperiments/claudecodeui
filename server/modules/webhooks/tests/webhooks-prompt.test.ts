import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildWebhookPrompt } from '@/modules/webhooks/webhooks-runner.service.js';
import type { WebhookIngestPayload, WebhookSource } from '@/modules/webhooks/webhooks.types.js';

const sampleSource = (overrides: Partial<WebhookSource> = {}): WebhookSource => ({
  source_id: 'sid',
  source: 'xspeech',
  name: 'XSpeech',
  description: '',
  enabled: true,
  provider: 'claude',
  model: null,
  prompt: 'S={{source}} T={{title}} X={{text}} ID={{delivery_id}}',
  permission_mode: 'bypassPermissions',
  mcp_tools: [],
  skills: [],
  profile_id: null,
  scope: 'global',
  project_id: null,
  retryMax: 3,
  retryBackoffSeconds: 60,
  secret: null,
  created_at: '',
  updated_at: '',
  ...overrides,
});

const basePayload = (overrides: Partial<WebhookIngestPayload> = {}): WebhookIngestPayload => ({
  source: 'xspeech',
  text: 'Hello world notes',
  title: 'My title',
  payload: { foo: 1 },
  meta: {},
  raw: { text: 'Hello world notes' },
  ...overrides,
});

describe('buildWebhookPrompt', () => {
  it('substitutes placeholders', () => {
    const out = buildWebhookPrompt(sampleSource(), basePayload(), 'del-123');
    assert.match(out, /S=xspeech/);
    assert.match(out, /T=My title/);
    assert.match(out, /X=Hello world notes/);
    assert.match(out, /ID=del-123/);
  });

  it('includes payload JSON', () => {
    const out = buildWebhookPrompt(
      sampleSource({ prompt: '{{payload}}' }),
      basePayload(),
      'd1',
    );
    assert.match(out, /"foo": 1/);
  });

  it('uses default template when empty', () => {
    const out = buildWebhookPrompt(
      sampleSource({ prompt: '' }),
      basePayload(),
      'd1',
    );
    assert.match(out, /Hello world notes/);
  });

  it('prepends skills when configured', () => {
    const out = buildWebhookPrompt(
      sampleSource({ skills: ['project-memory'], prompt: 'BODY' }),
      basePayload(),
      'd1',
    );
    assert.match(out, /project-memory/);
    assert.match(out, /BODY/);
  });
});
