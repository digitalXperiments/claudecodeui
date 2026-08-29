import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import {
  canonicalizeCatalogModels,
  matchBenchmarkFamily,
  outcomeCorrection,
  rankCandidatesForTask,
  refreshModelRegistry,
  setModelEnabled,
  setStaffingPrefs,
  upsertModelCapability,
} from '@/modules/swarm/model-registry.service.js';
import {
  staffPlanSeats,
  staffTask,
  MAX_SAME_MODEL_SEATS,
} from '@/modules/swarm/swarm-staffing.service.js';
import { makeScratchDir } from '@/shared/scratch.js';

async function withDatabase(callback: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await makeScratchDir('model-registry-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  try {
    await callback();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
}

function capability(overrides: Partial<Parameters<typeof upsertModelCapability>[0]> = {}) {
  return {
    modelId: 'test-model',
    provider: 'claude',
    displayName: null,
    contextWindow: 200_000,
    maxContextWindow: 200_000,
    officialContextWindow: 200_000,
    inputCostPerMtok: 1,
    outputCostPerMtok: 5,
    codingScore: 0.8,
    agenticScore: 0.8,
    longContextScore: 0.7,
    speedScore: null,
    confidence: 0.9,
    sources: ['catalog', 'benchmark-snapshot'],
    aliases: [],
    assessmentKind: 'benchmark' as const,
    fetchedAt: new Date().toISOString(),
    enabled: true,
    ...overrides,
  };
}

test('benchmark family matching prefers the longest fragment and nearest version', () => {
  const matched = matchBenchmarkFamily('claude-sonnet-4-20260115');
  assert.ok(matched, 'sonnet id should match a family');
  assert.equal(matched.family, 'claude-4-sonnet-class');

  const flash = matchBenchmarkFamily('gemini-3.5-flash');
  assert.ok(flash);
  assert.equal(flash.family, 'gemini-flash-class');

  assert.equal(matchBenchmarkFamily('totally-unknown-model'), null);
});

test('current Claude, Codex, and Grok models match exact heuristic families', () => {
  assert.equal(matchBenchmarkFamily('claude-opus-5[1m]')?.family, 'claude-opus-5');
  assert.equal(matchBenchmarkFamily('claude-fable-5')?.family, 'claude-fable-5');
  assert.equal(matchBenchmarkFamily('gpt-5.6-sol')?.family, 'gpt-5.6-sol');
  assert.equal(matchBenchmarkFamily('gpt-5.6-terra')?.family, 'gpt-5.6-terra');
  assert.equal(matchBenchmarkFamily('gpt-5.6-luna')?.family, 'gpt-5.6-luna');
  assert.equal(matchBenchmarkFamily('grok-4.6')?.family, 'grok-4.6');
});

test('Claude invocation aliases collapse onto one canonical profile', () => {
  const canonical = canonicalizeCatalogModels([
    { value: 'default', label: 'Default', resolvedModel: 'claude-opus-5[1m]' },
    { value: 'opus[1m]', label: 'Opus 5 (1M)', resolvedModel: 'claude-opus-5[1m]' },
    { value: 'sonnet', label: 'Sonnet 5', resolvedModel: 'claude-sonnet-5' },
  ]);
  assert.equal(canonical.length, 2);
  assert.deepEqual(canonical[0]?.aliases, ['default', 'opus[1m]']);
  assert.equal(canonical[0]?.record.label, 'Opus 5 (1M)');
});

test('rankCandidatesForTask applies the difficulty floor and cost frontier', async () => {
  await withDatabase(async () => {
    await refreshModelRegistry({ providers: [] }); // ensure schema exists
    upsertModelCapability(capability({ modelId: 'cheap-ok', outputCostPerMtok: 0.5, codingScore: 0.6 }));
    upsertModelCapability(capability({ modelId: 'pricey-great', outputCostPerMtok: 20, codingScore: 0.95 }));
    upsertModelCapability(capability({ modelId: 'cheap-weak', outputCostPerMtok: 0.1, codingScore: 0.25 }));

    // Basic task: the cheap qualifying model wins over the pricey great one.
    const basic = rankCandidatesForTask({ kind: 'implementer', difficulty: 'basic' });
    assert.equal(basic[0].modelId, 'cheap-ok');

    // Advanced task: only the strong model clears the bar.
    const advanced = rankCandidatesForTask({ kind: 'implementer', difficulty: 'advanced' });
    assert.equal(advanced[0].modelId, 'pricey-great');
  });
});

test('basic Codex work prefers Luna while advanced work reserves Sol', async () => {
  await withDatabase(async () => {
    upsertModelCapability(capability({
      provider: 'codex', modelId: 'gpt-5.6-sol', codingScore: 0.96, agenticScore: 0.96,
      longContextScore: 0.95, speedScore: 0.52, confidence: 0.78,
    }));
    upsertModelCapability(capability({
      provider: 'codex', modelId: 'gpt-5.6-luna', codingScore: 0.73, agenticScore: 0.76,
      longContextScore: 0.86, speedScore: 0.94, confidence: 0.78,
    }));

    const basic = rankCandidatesForTask({ kind: 'implementer', difficulty: 'basic' });
    const advanced = rankCandidatesForTask({ kind: 'implementer', difficulty: 'advanced' });
    assert.equal(basic[0]?.modelId, 'gpt-5.6-luna');
    assert.equal(advanced[0]?.modelId, 'gpt-5.6-sol');
  });
});

test('explorer routing uses agentic and long-context scores instead of coding alone', async () => {
  await withDatabase(async () => {
    upsertModelCapability(capability({
      modelId: 'coding-only', codingScore: 0.98, agenticScore: 0.4, longContextScore: 0.4, speedScore: 0.7,
    }));
    upsertModelCapability(capability({
      modelId: 'agentic-explorer', codingScore: 0.72, agenticScore: 0.95, longContextScore: 0.95, speedScore: 0.7,
    }));

    const ranked = rankCandidatesForTask({ kind: 'explorer', difficulty: 'advanced' });
    assert.equal(ranked[0]?.modelId, 'agentic-explorer');
  });
});

test('staffTask enforces the same-model diversity cap and returns rationales', async () => {
  await withDatabase(async () => {
    for (let i = 0; i < 5; i += 1) {
      upsertModelCapability(capability({ modelId: `mono-${i}`, codingScore: 0.9 - i * 0.01 }));
    }
    const seats = staffTask({ kind: 'implementer', difficulty: 'medium', seats: 10 });
    assert.ok(seats.length > 0);
    const perModel = new Map<string, number>();
    for (const seat of seats) {
      perModel.set(seat.model, (perModel.get(seat.model) ?? 0) + 1);
    }
    for (const count of perModel.values()) {
      assert.ok(count <= MAX_SAME_MODEL_SEATS, 'no model may exceed the diversity cap');
    }
    for (const seat of seats) {
      assert.match(seat.rationale, /registry:/);
    }
  });
});

test('live outcome correction pulls scores within bounds', async () => {
  await withDatabase(async () => {
    const neutral = await outcomeCorrection('never-seen-model', 'implementer');
    assert.equal(neutral.multiplier, 1);

    // Direct unit bound: correction is clamped to [0.65, 1.35].
    const clamped = Math.max(0.65, Math.min(1.35, 1 + 0.35 * 99));
    assert.equal(clamped, 1.35);
  });
});

test('disabled models and provider allow-list are excluded from ranking', async () => {
  await withDatabase(async () => {
    upsertModelCapability(capability({ modelId: 'keep-me', provider: 'claude', codingScore: 0.7 }));
    upsertModelCapability(capability({ modelId: 'drop-me', provider: 'claude', codingScore: 0.95 }));
    upsertModelCapability(capability({ modelId: 'other-agent', provider: 'grok', codingScore: 0.9 }));
    setModelEnabled('claude', 'drop-me', false);
    setStaffingPrefs({ allowedProviders: ['claude'] });

    const ranked = rankCandidatesForTask({ kind: 'implementer', difficulty: 'medium' });
    assert.equal(ranked.some((row) => row.modelId === 'drop-me'), false);
    assert.equal(ranked.some((row) => row.provider === 'grok'), false);
    assert.equal(ranked[0].modelId, 'keep-me');
  });
});

test('staffPlanSeats covers plan buckets without orchestrator seats', async () => {
  await withDatabase(async () => {
    upsertModelCapability(capability({ modelId: 'impl-model' }));
    upsertModelCapability(capability({ modelId: 'explore-model', agenticScore: 0.95 }));
    const seats = staffPlanSeats({
      plan: {
        steps: [
          { kind: 'orchestrator', difficulty: 'advanced' },
          { kind: 'implementer', difficulty: 'medium' },
          { kind: 'explorer', difficulty: 'basic' },
        ],
      },
    });
    const kinds = seats.map((seat) => seat.kind);
    assert.ok(kinds.includes('implementer'));
    assert.ok(kinds.includes('explorer'));
    assert.ok(!kinds.includes('orchestrator'), 'orchestrator is never staffed from the registry');
  });
});
