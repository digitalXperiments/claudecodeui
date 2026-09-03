import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatMessage } from '../types/types';

import {
  exportToHTML,
  exportToMarkdown,
  EXPORT_FORMATS,
} from './chatExport';

const messages: ChatMessage[] = [
  {
    id: 'user-1',
    type: 'user',
    content: 'Please inspect this file.',
    timestamp: '2026-08-31T10:00:00.000Z',
  },
  {
    id: 'assistant-1',
    type: 'assistant',
    content: 'The file is <healthy>.',
    timestamp: '2026-08-31T10:00:02.000Z',
  },
  {
    id: 'tool-1',
    type: 'assistant',
    isToolUse: true,
    toolName: 'Read',
    toolInput: { file_path: 'src/example.ts' },
    toolResult: { content: 'const answer = 42;', isError: false },
    timestamp: '2026-08-31T10:00:03.000Z',
  },
];

test('Markdown export preserves message order, metadata, and tool details', () => {
  const markdown = exportToMarkdown(messages, 'Code review');

  assert.match(markdown, /^# Code review\n/);
  assert.match(markdown, /## You[\s\S]*Please inspect this file\.[\s\S]*## Assistant/);
  assert.match(markdown, /Read[\s\S]*Input:\n\{\n {2}"file_path": "src\/example\.ts"\n\}[\s\S]*Result:\nconst answer = 42;/);
  assert.match(markdown, /<small>Aug 31, 2026/);
});

test('HTML export escapes transcript content and titles', () => {
  const html = exportToHTML(messages, '<unsafe>\nreview');

  assert.match(html, /<title>&lt;unsafe&gt; review<\/title>/);
  assert.match(html, /The file is &lt;healthy&gt;\./);
  assert.doesNotMatch(html, /<healthy>/);
  assert.match(html, /class="message user"/);
  assert.match(html, /class="message assistant"/);
});

test('exports can omit metadata while retaining localized labels', () => {
  const markdown = exportToMarkdown(messages, undefined, {
    includeMeta: false,
    labels: { user: 'Utilisateur', assistant: 'Assistant·e' },
  });

  assert.match(markdown, /^# Chat Export\n/);
  assert.match(markdown, /## Utilisateur/);
  assert.match(markdown, /## Assistant·e/);
  assert.doesNotMatch(markdown, /\*\*Exported:\*\*/);
});

test('the menu exposes exactly the three supported download formats', () => {
  assert.deepEqual(
    EXPORT_FORMATS.map((format) => format.id),
    ['markdown', 'html', 'pdf'],
  );
});
