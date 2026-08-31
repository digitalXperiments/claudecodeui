import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import type crossSpawn from 'cross-spawn';

import {
  OMP_FALLBACK_MODELS,
  OmpProviderModels,
  parseOmpLegacyModelsTable,
  parseOmpModelsJson,
  runOmpModelCommand,
} from '@/modules/providers/list/omp/omp-models.provider.js';

const validCatalog = JSON.stringify({
  models: [
    {
      provider: 'openai-codex',
      id: 'gpt-5.4',
      selector: 'openai-codex/gpt-5.4',
      name: 'GPT-5.4',
      contextWindow: 400_000,
      maxTokens: 128_000,
      reasoning: true,
      thinking: ['off', 'low', 'high'],
    },
    {
      provider: 'anthropic',
      id: 'claude-sonnet',
      selector: 'anthropic/claude-sonnet',
      name: 'Claude Sonnet',
      contextWindow: 200_000,
      maxTokens: 64_000,
      reasoning: false,
      thinking: [],
    },
  ],
});

test('OMP JSON catalog maps selectors, qualified labels, exact thinking, and token metadata', () => {
  const catalog = parseOmpModelsJson(validCatalog);
  assert.ok(catalog);
  assert.equal(catalog.DEFAULT, 'openai-codex/gpt-5.4');
  assert.ok(catalog.OPTIONS.some((option) => option.value === catalog.DEFAULT));
  assert.deepEqual(catalog.OPTIONS[0], {
    value: 'openai-codex/gpt-5.4',
    label: 'GPT-5.4 (openai-codex)',
    description: 'openai-codex',
    resolvedModel: 'gpt-5.4',
    runtimeContextWindow: 400_000,
    runtimeMaxOutputTokens: 128_000,
    effort: { values: [{ value: 'off' }, { value: 'low' }, { value: 'high' }] },
  });
  assert.equal(catalog.OPTIONS[1]?.effort, undefined);
});

test('OMP JSON catalog rejects malformed and empty payloads and deduplicates selectors', () => {
  assert.equal(parseOmpModelsJson('{not-json'), null);
  assert.equal(parseOmpModelsJson(JSON.stringify({ models: [] })), null);
  assert.equal(parseOmpModelsJson(JSON.stringify({ models: [{ provider: 'x' }] })), null);

  const duplicate = JSON.parse(validCatalog) as { models: Record<string, unknown>[] };
  duplicate.models.push({ ...duplicate.models[0], id: 'duplicate-id' });
  const catalog = parseOmpModelsJson(JSON.stringify(duplicate));
  assert.equal(catalog?.OPTIONS.length, 2);
  assert.ok(catalog?.OPTIONS.some((option) => option.value === catalog.DEFAULT));
});

test('OMP Unicode box-table fallback skips decoration and preserves typed metadata', () => {
  const table = [
    '┌────────────────┬─────────┬─────────┬─────────┬──────────┐',
    '│ provider       │ model   │ context │ max-out │ thinking │',
    '├────────────────┼─────────┼─────────┼─────────┼──────────┤',
    '│ openai-codex   │ gpt-5.4 │ 400K    │ 128K    │ yes      │',
    '└────────────────┴─────────┴─────────┴─────────┴──────────┘',
  ].join('\n');
  const catalog = parseOmpLegacyModelsTable(table);
  assert.equal(catalog?.OPTIONS.length, 1);
  assert.equal(catalog?.OPTIONS[0]?.value, 'openai-codex/gpt-5.4');
  assert.equal(catalog?.OPTIONS[0]?.runtimeContextWindow, 400_000);
  assert.equal(catalog?.OPTIONS[0]?.runtimeMaxOutputTokens, 128_000);
  assert.ok(catalog?.OPTIONS.some((option) => option.value === catalog.DEFAULT));
});

test('OMP model provider is JSON-first and falls back for malformed or empty discovery', async () => {
  const calls: string[][] = [];
  const valid = new OmpProviderModels({
    runCommand: async (argv) => {
      calls.push(argv);
      return validCatalog;
    },
  });
  assert.equal((await valid.getSupportedModels()).OPTIONS.length, 2);
  assert.deepEqual(calls, [['models', '--json']]);

  const malformed = new OmpProviderModels({
    runCommand: async (argv) => argv.includes('--json') ? '{bad' : '',
  });
  assert.deepEqual(await malformed.getSupportedModels(), OMP_FALLBACK_MODELS);
});

const createFakeSpawn = (behavior: 'nonzero' | 'timeout'): typeof crossSpawn => ((
  _command: string,
  _args?: readonly string[],
) => {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: () => boolean;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  if (behavior === 'nonzero') {
    queueMicrotask(() => child.emit('close', 2));
  }
  return child;
}) as unknown as typeof crossSpawn;

test('OMP model command rejects nonzero exits and terminates timeouts', async () => {
  assert.equal(await runOmpModelCommand(['models', '--json'], {
    spawn: createFakeSpawn('nonzero'),
    timeoutMs: 50,
  }), null);
  assert.equal(await runOmpModelCommand(['models', '--json'], {
    spawn: createFakeSpawn('timeout'),
    timeoutMs: 5,
  }), null);
});
