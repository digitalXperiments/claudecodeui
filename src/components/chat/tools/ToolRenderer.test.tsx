import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ToolRenderer } from './ToolRenderer';

function renderTool(overrides: Partial<React.ComponentProps<typeof ToolRenderer>> = {}) {
  return renderToStaticMarkup(
    <ToolRenderer
      toolName="exec"
      toolInput={'await tools.exec_command({ cmd: "git status" })'}
      toolResult={{ content: 'clean', isError: false }}
      mode="input"
      {...overrides}
    />,
  );
}

test('generic tools combine Parameters and Result in one collapsed compact row', () => {
  const html = renderTool();

  assert.match(html, />exec</);
  assert.match(html, /exec_command/);
  assert.match(html, /Parameters/);
  assert.match(html, /Result/);
  assert.match(html, /clean/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /hidden=""/);
  assert.equal(renderTool({ mode: 'result' }), '');
});

test('generic running tools show an explicit status', () => {
  const html = renderTool({ toolResult: null });

  assert.match(html, />Running</);
  assert.match(html, /aria-expanded="false"/);
});

test('generic errors and denials start expanded', () => {
  const errorHtml = renderTool({ toolResult: { content: 'boom', isError: true } });
  const deniedHtml = renderTool({
    toolResult: { content: 'User denied tool use', isError: true },
  });

  assert.match(errorHtml, />Error</);
  assert.match(errorHtml, /aria-expanded="true"/);
  assert.doesNotMatch(errorHtml, /hidden=""/);
  assert.match(deniedHtml, />Denied</);
  assert.match(deniedHtml, /aria-expanded="true"/);
});

test('all shell aliases use one integrated Bash row and suppress the result render', () => {
  for (const toolName of ['Bash', 'bash', 'shell', 'shell_command']) {
    const html = renderTool({
      toolName,
      toolInput: { command: 'npm test' },
      toolResult: { content: 'passed', isError: false },
    });

    assert.match(html, /npm test/, toolName);
    assert.match(html, /1 line/, toolName);
    assert.match(html, /aria-expanded="false"/, toolName);
    assert.equal(renderTool({ toolName, mode: 'result' }), '', toolName);
  }
});

test('shell running state stays visible and shell failure output starts expanded', () => {
  const runningHtml = renderTool({
    toolName: 'shell_command',
    toolInput: { command: 'npm test' },
    toolResult: null,
  });
  const failedHtml = renderTool({
    toolName: 'bash',
    toolInput: { cmd: 'npm test' },
    toolResult: { content: 'failed', isError: true },
  });

  assert.match(runningHtml, /aria-label="Running"/);
  assert.match(failedHtml, />Error</);
  assert.match(failedHtml, /aria-expanded="true"/);
  assert.doesNotMatch(failedHtml, /hidden=""/);
});
