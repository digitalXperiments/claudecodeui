import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractShellCommand,
  formatToolDetail,
  getSafeToolPreview,
  getToolPresentationKind,
  isShellToolName,
  usesIntegratedToolResult,
} from './toolPresentation';

test('normalizes provider shell aliases without treating Codex exec as a shell command', () => {
  for (const name of ['Bash', 'bash', 'shell', 'shell_command', ' SHELL_COMMAND ']) {
    assert.equal(isShellToolName(name), true, name);
    assert.equal(getToolPresentationKind(name), 'shell', name);
    assert.equal(usesIntegratedToolResult(name), true, name);
  }

  assert.equal(isShellToolName('exec'), false);
  assert.equal(getToolPresentationKind('exec'), 'generic');
  assert.equal(usesIntegratedToolResult('exec'), true);
});

test('keeps configured interactive tools on their existing presentation path', () => {
  assert.equal(getToolPresentationKind('AskUserQuestion'), 'configured');
  assert.equal(getToolPresentationKind('ask_user_question'), 'configured');
  assert.equal(usesIntegratedToolResult('AskUserQuestion'), false);
});

test('extracts shell commands from object, JSON, and raw string inputs', () => {
  assert.equal(extractShellCommand({ command: 'npm test' }), 'npm test');
  assert.equal(extractShellCommand('{"cmd":"git status"}'), 'git status');
  assert.equal(extractShellCommand('pwd'), 'pwd');
});

test('builds useful bounded previews without evaluating exec source', () => {
  const marker = '__cloudcliCompactToolPreviewExecuted';
  delete (globalThis as Record<string, unknown>)[marker];
  const source = `globalThis.${marker} = true; await tools.exec_command({ cmd: "pwd" }); await tools.view_image({ path: "x" });`;

  assert.equal(getSafeToolPreview('exec', source), 'exec_command, view_image');
  assert.equal((globalThis as Record<string, unknown>)[marker], undefined);
  assert.equal(getSafeToolPreview('custom_search', { query: '  compact   tools  ' }), 'compact tools');
  assert.equal(getSafeToolPreview('custom_tool', { alpha: 1, beta: 2 }), 'alpha, beta');
  assert.equal(getSafeToolPreview('custom_tool', 'x'.repeat(140)).length, 120);
});

test('formats structured details while preserving plain text', () => {
  assert.equal(formatToolDetail('plain output'), 'plain output');
  assert.equal(formatToolDetail('{"ok":true}'), '{\n  "ok": true\n}');
  assert.equal(formatToolDetail({ ok: true }), '{\n  "ok": true\n}');
  assert.equal(formatToolDetail(undefined), '');
});
