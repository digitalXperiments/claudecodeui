import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { BotProposal, BotRule, BotTrigger } from '../../../types/botRuntime';

// The components call authenticatedFetch only inside effects, which static rendering never runs;
// stub the browser globals the api module reads at import time anyway.
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: () => null, setItem: () => undefined, removeItem: () => undefined, clear: () => undefined, key: () => null, length: 0,
};

const { default: TriggerEditor } = await import('./triggers/TriggerEditor');
const { default: TriggerRow } = await import('./triggers/TriggerRow');
const { default: RecentEvents } = await import('./triggers/RecentEvents');
const { default: RuleForm } = await import('./rules/RuleForm');
const { default: RuleRow } = await import('./rules/RuleRow');
const { default: SafetyFloorCard } = await import('./rules/SafetyFloorCard');
const { default: ProposalCard } = await import('./learning/ProposalCard');

const noop = () => undefined;
const html = (node: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(node);

const trigger = (kind: string, config: Record<string, unknown>, cursor: Record<string, unknown> = {}): BotTrigger => ({
  trigger_id: 'trig-1', bot_id: 'b1', kind, config, enabled: true, cursor, last_fired_at: null, created_at: '', updated_at: '',
});

test('the trigger editor renders each kind with its fields', () => {
  const create = html(createElement(TriggerEditor, { botId: 'b1', trigger: null, onSaved: noop, onCancel: noop }));
  assert.match(create, /New trigger/);
  assert.match(create, /Create trigger/);
  assert.match(html(createElement(TriggerEditor, { botId: 'b1', trigger: trigger('interval', { every_s: 900 }), onSaved: noop, onCancel: noop })), /Interval unit/);
  const hook = html(createElement(TriggerEditor, { botId: 'b1', trigger: trigger('webhook', { secret_ref: 'HOOK' }), onSaved: noop, onCancel: noop }));
  assert.match(hook, /\/api\/hooks\/bots\/trig-1/);
  assert.match(hook, /X-Webhook-Signature/);
  assert.match(hook, /Settings → Secrets/);
  const dir = html(createElement(TriggerEditor, { botId: 'b1', trigger: trigger('watch', { adapter: 'directory', path: '~/Documents/x', interval_s: 300 }), onSaved: noop, onCancel: noop }));
  assert.match(dir, /macOS/);
  assert.match(html(createElement(TriggerEditor, { botId: 'b1', trigger: trigger('run_completed', { allow_bot_origin: true }), onSaved: noop, onCancel: noop })), /Also wake for things bots did/);
});

test('a trigger row shows the summary, the webhook path and a failing watch', () => {
  const row = html(createElement(TriggerRow, {
    trigger: trigger('watch', { adapter: 'rss', url: 'https://a.b/feed', interval_s: 300 }, { last_error: 'HTTP 500' }),
    now: Date.now(), busy: false, onToggle: noop, onEdit: noop, onDelete: noop, onTest: noop,
  }));
  assert.match(row, /RSS https:\/\/a\.b\/feed/);
  assert.match(row, /HTTP 500/);
  assert.match(row, /Test fire/);
  const hook = html(createElement(TriggerRow, { trigger: trigger('webhook', { secret_ref: 'S' }), now: Date.now(), busy: false, onToggle: noop, onEdit: noop, onDelete: noop, onTest: noop }));
  assert.match(hook, /\/api\/hooks\/bots\/trig-1/);
});

test('recent events show trust badges', () => {
  const events = [
    { event_id: 'e1', bot_id: 'b1', trigger_id: null, source: 'webhook', kind: 'webhook', dedupe_key: null, trust: 'external' as const, payload: {}, status: 'queued' as const, episode_id: null, received_at: new Date().toISOString(), claimed_at: null },
  ];
  assert.match(html(createElement(RecentEvents, { events, now: Date.now() })), /External/);
  assert.match(html(createElement(RecentEvents, { events: [], now: Date.now() })), /No events yet/);
});

const rule = (overrides: Partial<BotRule> = {}): BotRule => ({
  rule_id: 'r1', scope: 'bot', bot_id: 'b1', match: { server: 'gmail', tool: 'send_email', risk: ['send'], args: [{ path: 'to', op: 'contains', value: '@eyewa.com' }] },
  decision: 'allow', priority: 2, created_from: 'always_allow_click', note: 'trusted', expires_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
  created_at: '', updated_at: '', ...overrides,
});

test('rule rows and the rule form render the match, risk chips and the floor warning', () => {
  const row = html(createElement(RuleRow, { rule: rule(), now: Date.now(), busy: false, onEdit: noop, onDelete: noop }));
  assert.match(row, /gmail · send_email/);
  assert.match(row, /risk · send/);
  assert.match(row, /to contains/);
  assert.match(row, /Always-allow click/);
  assert.match(row, /Expires in [23]d/);
  const form = html(createElement(RuleForm, { botId: 'b1', rule: rule(), onSaved: noop, onCancel: noop }));
  assert.match(form, /WITHOUT asking/);
  assert.match(form, /I understand, save rule/);
  assert.match(html(createElement(RuleForm, { botId: 'b1', rule: null, onSaved: noop, onCancel: noop })), /Type a concrete tool name/);
  assert.match(html(createElement(SafetyFloorCard)), /prod_change/);
});

const proposal = (overrides: Partial<BotProposal> = {}): BotProposal => ({
  proposal_id: 'p1', bot_id: 'b1', kind: 'rule', title: 'Always allow gmail.send_email', body: 'You approved it 10 times.',
  payload: { server: 'gmail', tool: 'send_email', risk: 'send', floor: true, expires_days: 30 }, evidence: ['ep-aaaaaaaaaa', 'item-1'],
  confidence: 0.82, status: 'proposed', created_at: new Date().toISOString(), decided_at: null, ...overrides,
});

test('a floor rule proposal warns loudly and offers approve anyway', () => {
  const card = html(createElement(ProposalCard, { proposal: proposal(), now: Date.now(), busy: false, knownEpisodes: ['ep-aaaaaaaaaa'], knownDecisions: [], onApprove: noop, onReject: noop }));
  assert.match(card, /without asking you/);
  assert.match(card, /Approve anyway/);
  assert.match(card, /confidence 82%/);
  assert.match(card, /episode/);
  assert.doesNotMatch(card, /Edit first/);
  const memory = html(createElement(ProposalCard, { proposal: proposal({ kind: 'memory', payload: {} }), now: Date.now(), busy: false, knownEpisodes: [], knownDecisions: [], onApprove: noop, onReject: noop }));
  assert.match(memory, /Edit first/);
  assert.doesNotMatch(memory, /Approve anyway/);
  const decided = html(createElement(ProposalCard, { proposal: proposal({ status: 'approved' }), now: Date.now(), busy: false, knownEpisodes: [], knownDecisions: [], onApprove: noop, onReject: noop }));
  assert.doesNotMatch(decided, /Reject/);
});
