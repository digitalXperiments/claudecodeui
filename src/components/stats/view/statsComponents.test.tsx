/**
 * Render tests for the Stats dashboard UI states, using node:test +
 * renderToStaticMarkup (the repo's established client-side test layer; see
 * src/components/chat/tools/components/ContentRenderers/QuestionAnswerContent.test.tsx).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// NOTE: StatsPanel itself is not imported here — its module chain reaches
// src/constants/config.ts (import.meta.env), which only exists under Vite.
// Panel-level behavior is covered by the server route tests and typecheck;
// these tests cover the reusable dashboard components' render states.
import type { StatsDayBucket } from '../api/statsApi';

import BreakdownList from './subcomponents/BreakdownList';
import HourOfDayChart from './subcomponents/HourOfDayChart';
import KpiCard from './subcomponents/KpiCard';
import UsageOverTimeChart from './subcomponents/UsageOverTimeChart';

function day(partial: Partial<StatsDayBucket> & { day: string }): StatsDayBucket {
  return {
    runs: 0,
    tokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    durationMs: 0,
    conversations: 0,
    ...partial,
  };
}

test('KpiCard renders label, value, and sub-line', () => {
  const html = renderToStaticMarkup(
    React.createElement(KpiCard, {
      icon: React.createElement('span'),
      label: 'Total tokens',
      value: '1.2M',
      sub: '900k in · 300k out',
    }),
  );
  assert.ok(html.includes('Total tokens'));
  assert.ok(html.includes('1.2M'));
  assert.ok(html.includes('900k in · 300k out'));
});

test('UsageOverTimeChart renders bars, legend, and a data-table fallback', () => {
  const days = [
    day({ day: '2026-08-04', tokens: 1000, inputTokens: 700, outputTokens: 300, runs: 2 }),
    day({ day: '2026-08-05', tokens: 0, runs: 1 }),
    day({ day: '2026-08-06', tokens: 500, inputTokens: 500, outputTokens: 0, runs: 1 }),
  ];
  const html = renderToStaticMarkup(React.createElement(UsageOverTimeChart, { days }));
  assert.ok(html.includes('<svg'), 'chart renders an SVG');
  assert.ok(html.includes('Input tokens') && html.includes('Output tokens'), 'legend is text-labeled');
  assert.ok(html.includes('View as data table'), 'accessible table fallback exists');
  assert.ok(html.includes('1,000'), 'exact token count appears in the table');
  assert.ok(html.includes('Days are UTC'), 'UTC unit note renders');
});

test('UsageOverTimeChart with zero-token range shows a sparse-data notice', () => {
  const html = renderToStaticMarkup(
    React.createElement(UsageOverTimeChart, { days: [day({ day: '2026-08-04', runs: 3 })] }),
  );
  assert.ok(html.includes('none reported token usage'), 'sparse token state is explicit');
  assert.ok(!html.includes('<svg'), 'no fake bars when nothing was reported');
});

test('HourOfDayChart renders 24 labeled buckets', () => {
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, runs: hour === 9 ? 4 : 0 }));
  const html = renderToStaticMarkup(React.createElement(HourOfDayChart, { hours }));
  assert.ok(html.includes('Runs by hour of day'));
  assert.ok(html.includes('UTC'), 'timezone is labeled');
  assert.ok(html.includes('09:00 UTC — 4 runs started'), 'bar carries a text tooltip');
});

test('BreakdownList renders shares, unknown labels, empty and overflow states', () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({
    key: `row-${index}`,
    label: index === 9 ? 'Unknown model' : `model-${index}`,
    tokens: 1000 - index * 100,
    runs: index + 1,
    isUnknown: index === 9,
  }));

  const html = renderToStaticMarkup(
    React.createElement(BreakdownList, {
      title: 'By model',
      rows,
      totalTokens: 5500,
      emptyText: 'No model data in this range.',
    }),
  );
  assert.ok(html.includes('By model'));
  assert.ok(html.includes('model-0'));
  assert.ok(!html.includes('model-9'), 'rows beyond maxRows are collapsed');
  assert.ok(html.includes('Show 2 more'), 'overflow toggle renders');
  assert.ok(html.includes('18%'), 'share percentage renders for the top row');

  const empty = renderToStaticMarkup(
    React.createElement(BreakdownList, {
      title: 'By model',
      rows: [],
      totalTokens: 0,
      emptyText: 'No model data in this range.',
    }),
  );
  assert.ok(empty.includes('No model data in this range.'), 'empty state renders');

  const unknown = renderToStaticMarkup(
    React.createElement(BreakdownList, {
      title: 'By provider',
      rows: [
        {
          key: '__unknown__',
          label: 'Unknown provider',
          tokens: 10,
          runs: 1,
          isUnknown: true,
        },
      ],
      totalTokens: 10,
      emptyText: 'No provider data in this range.',
    }),
  );
  assert.ok(unknown.includes('Unknown provider'), 'unknown provider is labeled, not blank');
});
