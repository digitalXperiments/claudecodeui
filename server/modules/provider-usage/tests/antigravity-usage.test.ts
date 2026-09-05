import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseAgyUsagePayload,
  readAgyJsonEnvelope,
  readAgyUsageGroups,
  resolveAgyCliCommand,
  type AgyUsageGroup,
} from '@/modules/providers/index.js';
import type { ProviderAuthStatus } from '@/shared/types.js';

import { createAntigravityUsageAdapter } from '../provider-usage.adapters.js';

const context = {
  authStatus: {
    provider: 'antigravity',
    installed: true,
    authenticated: true,
    email: null,
    method: 'oauth',
  } as unknown as ProviderAuthStatus,
};

/** Captured verbatim from `agy --output-format json -p=/usage` on 1.1.1. */
const REAL_ENVELOPE = {
  conversation_id: '',
  status: 'SUCCESS',
  response: 'Gemini Models\tWeekly Limit Remaining\t86%\t2026-09-11T01:22:24Z\n',
  num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  command: {
    name: 'usage',
    data: {
      description: 'Within each group, models share a weekly limit and a 5-hour limit.',
      groups: [
        {
          name: 'Gemini Models',
          description: 'Models within this group: Gemini Flash, Gemini Pro',
          buckets: [
            {
              id: 'gemini-weekly',
              name: 'Weekly Limit Remaining',
              description: 'You have used some of your weekly limit.',
              window: 'weekly',
              remaining_fraction: 0.8571669459342957,
              reset_time: '2026-09-11T01:22:24Z',
            },
            {
              id: 'gemini-5h',
              name: 'Five Hour Limit Remaining',
              window: '5h',
              remaining_fraction: 0.8159894943237305,
              reset_time: '2026-09-05T06:38:43Z',
            },
          ],
        },
        {
          name: 'Claude and GPT models',
          description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
          buckets: [
            {
              id: '3p-weekly',
              name: 'Weekly Limit Remaining',
              window: 'weekly',
              remaining_fraction: 1,
              reset_time: '2026-09-12T02:34:22Z',
            },
          ],
        },
      ],
    },
  },
};

describe('agy CLI usage payload', () => {
  it('parses the real /usage envelope into groups and buckets', () => {
    const groups = parseAgyUsagePayload(REAL_ENVELOPE);
    assert.deepEqual(groups.map((group) => group.name), ['Gemini Models', 'Claude and GPT models']);
    assert.deepEqual(groups[0].buckets.map((bucket) => bucket.id), ['gemini-weekly', 'gemini-5h']);
    assert.equal(groups[0].buckets[1].remainingFraction, 0.8159894943237305);
    assert.equal(groups[0].buckets[1].resetTime, '2026-09-05T06:38:43Z');
  });

  it('ignores an envelope from some other slash command', () => {
    // `/status` also returns `{ status: 'SUCCESS' }` with no quota in it;
    // mining that for quota-shaped fields would invent a meter.
    assert.deepEqual(parseAgyUsagePayload({ status: 'SUCCESS', command: { name: 'status', data: {} } }), []);
    assert.deepEqual(parseAgyUsagePayload({ status: 'SUCCESS' }), []);
    assert.deepEqual(parseAgyUsagePayload(null), []);
  });

  it('drops buckets with no id and groups left empty by that', () => {
    const groups = parseAgyUsagePayload({
      command: { name: 'usage', data: { groups: [{ name: 'Broken', buckets: [{ name: 'no id' }] }] } },
    });
    assert.deepEqual(groups, []);
  });

  it('keeps a bucket whose fraction is missing, reporting it as unknown', () => {
    const groups = parseAgyUsagePayload({
      command: { name: 'usage', data: { groups: [{ name: 'G', buckets: [{ id: 'b', name: 'B' }] }] } },
    });
    assert.equal(groups[0].buckets[0].remainingFraction, null);
  });

  it('finds the JSON envelope after advisory lines on stdout', () => {
    const stdout = [
      'A new version of agy is available.',
      'jetski: some advisory line',
      JSON.stringify(REAL_ENVELOPE),
    ].join('\n');
    assert.equal(readAgyJsonEnvelope(stdout)?.status, 'SUCCESS');
    assert.equal(readAgyJsonEnvelope('not json at all'), null);
  });

  it('resolves an explicit CLI path override ahead of PATH', () => {
    assert.equal(resolveAgyCliCommand({ CLOUDCLI_AGY_PATH: '/custom/agy' }), '/custom/agy');
  });

  it('surfaces the CLI\'s own wording when it runs but answers nothing', async () => {
    await assert.rejects(
      readAgyUsageGroups({}, async () => ({
        stdout: JSON.stringify({ status: 'SUCCESS', response: 'You are not logged into Antigravity.' }),
        stderr: '',
        code: 0,
      })),
      /not logged into Antigravity/,
    );
  });

  it('reports a missing CLI as not installed rather than a raw ENOENT', async () => {
    await assert.rejects(
      readAgyUsageGroups({}, async () => {
        const error = new Error('spawn agy ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }),
      /agy CLI is not installed/,
    );
  });
});

describe('antigravity usage adapter', () => {
  const adapterFor = (groups: AgyUsageGroup[]) => (
    createAntigravityUsageAdapter({ readUsageGroups: async () => groups })
  );

  it('turns the real payload into percent windows with session windows first', async () => {
    const result = await adapterFor(parseAgyUsagePayload(REAL_ENVELOPE))(context);

    assert.equal(result.status, 'ok');
    assert.deepEqual(result.windows.map((window) => [window.id, window.label, window.remaining]), [
      ['gemini-5h', 'Gemini Models · Five Hour', 82],
      ['gemini-weekly', 'Gemini Models · Weekly', 86],
      ['3p-weekly', 'Claude and GPT models · Weekly', 100],
    ]);
    assert.equal(result.windows[0].unit, 'percent');
    assert.equal(result.windows[0].limit, 100);
    assert.equal(result.windows[0].used, 18);
    assert.equal(result.windows[0].resetsAt, '2026-09-05T06:38:43Z');
    assert.equal(result.windows[1].resetsAt, '2026-09-11T01:22:24Z');
  });

  it('prioritizes the session window as primary even when weekly has lower remaining quota', async () => {
    const groups: AgyUsageGroup[] = [
      {
        name: 'Gemini Models',
        description: null,
        buckets: [
          {
            id: 'gemini-weekly',
            name: 'Weekly Limit Remaining',
            window: 'weekly',
            description: null,
            remainingFraction: 0.1,
            resetTime: '2026-09-11T01:22:24Z',
          },
          {
            id: 'gemini-5h',
            name: 'Five Hour Limit Remaining',
            window: '5h',
            description: null,
            remainingFraction: 0.95,
            resetTime: '2026-09-05T06:38:43Z',
          },
        ],
      },
    ];
    const result = await adapterFor(groups)(context);
    assert.equal(result.primaryWindowId, 'gemini-5h');
    assert.equal(result.windows[0].id, 'gemini-5h');
  });

  it('reports unavailable when the CLI returns no windows', async () => {
    const result = await adapterFor([])(context);
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(result.windows, []);
  });

  it('propagates a read failure so the service can mark the row stale', async () => {
    const adapter = createAntigravityUsageAdapter({
      readUsageGroups: async () => {
        throw new Error('Antigravity usage is unavailable: You are not logged into Antigravity.');
      },
    });
    await assert.rejects(adapter(context), /not logged into Antigravity/);
  });
});
