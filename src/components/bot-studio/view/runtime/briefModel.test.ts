import assert from 'node:assert/strict';
import test from 'node:test';

import type { BotBrief } from '../../types/botRuntime';

import {
  BRIEF_PRESETS,
  botRows,
  briefSince,
  commitmentRows,
  costRows,
  describeSendResult,
  formatDue,
  formatUsd,
  heldBackPings,
  learningGroups,
  summarizeBrief,
  titleLookup,
} from './briefModel';

const NOW = new Date('2026-10-01T12:00:00.000Z');

function makeBrief(overrides: Partial<BotBrief> = {}): BotBrief {
  return {
    generated_at: NOW.toISOString(),
    since: '2026-09-30T12:00:00.000Z',
    totals: { episodes: 0, failed: 0, cost_usd: 0 },
    bots: [],
    awaiting_you: { approvals: [], in_qa: [] },
    gate_decisions_awaiting: [],
    commitments_due: [],
    learning_proposals: [],
    suppressed: [],
    markdown: '',
    ...overrides,
  };
}

test('briefSince subtracts the preset window', () => {
  assert.equal(briefSince('24h', NOW), '2026-09-30T12:00:00.000Z');
  assert.equal(briefSince('3d', NOW), '2026-09-28T12:00:00.000Z');
  assert.equal(briefSince('7d', NOW), '2026-09-24T12:00:00.000Z');
  assert.deepEqual(BRIEF_PRESETS.map((entry) => entry.id), ['24h', '3d', '7d']);
});

test('formatUsd handles zero, tiny and normal amounts', () => {
  assert.equal(formatUsd(0), '$0.00');
  assert.equal(formatUsd(Number.NaN), '$0.00');
  assert.equal(formatUsd(0.004), '<$0.01');
  assert.equal(formatUsd(1.236), '$1.24');
});

test('formatDue reports overdue and upcoming in the nearest unit', () => {
  assert.deepEqual(formatDue('2026-10-01T10:00:00.000Z', NOW), { label: 'overdue 2h', overdue: true });
  assert.deepEqual(formatDue('2026-10-01T12:30:00.000Z', NOW), { label: 'due in 30m', overdue: false });
  assert.deepEqual(formatDue('2026-10-02T06:00:00.000Z', NOW), { label: 'due in 18h', overdue: false });
  assert.deepEqual(formatDue('2026-09-25T12:00:00.000Z', NOW), { label: 'overdue 6d', overdue: true });
  assert.deepEqual(formatDue('2026-10-01T12:00:10.000Z', NOW), { label: 'due now', overdue: false });
  assert.deepEqual(formatDue('nonsense', NOW), { label: 'nonsense', overdue: false });
});

test('titleLookup falls back to the id and to "All bots" for null', () => {
  const titleOf = titleLookup([{ section_id: 'a', title: 'Alpha' }]);
  assert.equal(titleOf('a'), 'Alpha');
  assert.equal(titleOf('zzz'), 'zzz');
  assert.equal(titleOf(null), 'All bots');
});

test('botRows puts failing bots first and computes cost share', () => {
  const brief = makeBrief({
    bots: [
      { bot_id: 'quiet', title: 'Quiet', episodes: { count: 9, succeeded: 9, failed: 0, top_summaries: [] }, cost_usd: 3 },
      { bot_id: 'bad', title: 'Bad', episodes: { count: 2, succeeded: 1, failed: 1, top_summaries: ['boom'] }, cost_usd: 1 },
      { bot_id: 'worse', title: '', episodes: { count: 2, succeeded: 0, failed: 2, top_summaries: [] }, cost_usd: 0 },
    ],
  });
  const rows = botRows(brief, (id) => `title:${id}`);
  assert.deepEqual(rows.map((row) => row.botId), ['worse', 'bad', 'quiet']);
  assert.equal(rows[0].title, 'title:worse');
  assert.equal(rows[0].hasFailures, true);
  assert.equal(rows[2].hasFailures, false);
  assert.equal(rows[2].costShare, 0.75);
  assert.deepEqual(costRows(rows).map((row) => row.botId), ['quiet', 'bad']);
});

test('botRows tolerates a zero total cost', () => {
  const rows = botRows(makeBrief({ bots: [{ bot_id: 'a', title: 'A', episodes: { count: 1, succeeded: 1, failed: 0, top_summaries: [] }, cost_usd: 0 }] }), (id) => id);
  assert.equal(rows[0].costShare, 0);
});

test('learningGroups groups by bot, largest group first', () => {
  const brief = makeBrief({
    learning_proposals: [
      { proposal_id: 'p1', bot_id: 'a', kind: 'memory', title: 'one', confidence: 0.9 },
      { proposal_id: 'p2', bot_id: 'b', kind: 'rule', title: 'two', confidence: 0.5 },
      { proposal_id: 'p3', bot_id: 'b', kind: 'goal', title: 'three', confidence: 0.4 },
    ],
  });
  const groups = learningGroups(brief, (id) => id.toUpperCase());
  assert.deepEqual(groups.map((group) => [group.botId, group.title, group.proposals.length]), [['b', 'B', 2], ['a', 'A', 1]]);
});

test('heldBackPings splits "<reason>: <title>" and keeps titles that contain colons', () => {
  const brief = makeBrief({
    suppressed: [
      { bot_id: 'a', channel: 'slack', reason: 'quiet_hours: Deploy: prod ready', created_at: '2026-10-01T02:00:00.000Z' },
      { bot_id: null, channel: 'webpush', reason: 'digest', created_at: '2026-10-01T03:00:00.000Z' },
    ],
  });
  assert.deepEqual(heldBackPings(brief).map((entry) => [entry.why, entry.title]), [['quiet hours', 'Deploy: prod ready'], ['digest', '']]);
});

test('commitmentRows attach a due label', () => {
  const rows = commitmentRows(makeBrief({ commitments_due: [{ commitment_id: 'c', bot_id: 'a', description: 'ship', due_at: '2026-10-01T11:00:00.000Z', waiting_on: null }] }), NOW);
  assert.equal(rows[0].due.label, 'overdue 1h');
  assert.equal(rows[0].due.overdue, true);
});

test('summarizeBrief reports quiet only when everything is empty', () => {
  assert.equal(summarizeBrief(makeBrief()).quiet, true);
  const busy = summarizeBrief(makeBrief({
    totals: { episodes: 0, failed: 0, cost_usd: 0 },
    awaiting_you: { approvals: [{ interrupt_id: 'i', bot_id: 'a', title: 't', kind: 'approval_pending', created_at: '' }], in_qa: [{ item_id: 'x', bot_id: 'a', title: 'q' }] },
    gate_decisions_awaiting: [{ decision_id: 'd', bot_id: 'a', server: 's', tool: 't', risk: 'send', interrupt_id: null }],
  }));
  assert.equal(busy.quiet, false);
  assert.equal(busy.awaitingCount, 2);
  assert.equal(busy.gateCount, 1);
  assert.equal(summarizeBrief(makeBrief({ totals: { episodes: 3, failed: 0, cost_usd: 1 } })).quiet, false);
});

test('describeSendResult summarises delivered, held back and failed channels', () => {
  assert.deepEqual(describeSendResult({ delivered: ['inapp', 'slack'], suppressed: [], failed: [] }), { text: 'Brief delivered on inapp, slack.', ok: true });
  const mixed = describeSendResult({ delivered: ['inapp'], suppressed: ['webpush'], failed: ['telegram'] });
  assert.equal(mixed.ok, false);
  assert.match(mixed.text, /held back on webpush/);
  assert.match(mixed.text, /failed on telegram/);
  assert.deepEqual(describeSendResult({}), { text: 'No channels are configured to receive the brief.', ok: false });
});
