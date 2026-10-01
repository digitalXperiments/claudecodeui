import assert from 'node:assert/strict';
import test from 'node:test';

import { emptyDraft } from '../view/tabs/runtime/triggers/triggerForm';

import { emptyRuntimeDraft } from './runtimeDraft';
import {
  budgetSummary, enforcementSummary, goalsSummary, learningSummary, rulesSummary, runtimeReviewRows, scheduleSummary, wakeSummary,
} from './reviewRows';

test('the schedule is described in words, including "only when I message it"', () => {
  assert.equal(scheduleSummary('*/30 * * * *', false), 'Every 30 minutes');
  assert.equal(scheduleSummary(null, true), 'Only when you message it (no schedule)');
  assert.equal(scheduleSummary('', false), 'Only when you message it (no schedule)');
  assert.equal(scheduleSummary('1 2 3 4 5', false), 'Cron · 1 2 3 4 5');
});

test('wake-ups list the schedule then every extra trigger', () => {
  const runtime = emptyRuntimeDraft();
  runtime.triggers = [{ ...emptyDraft('nl_schedule'), text: 'weekdays at 9am' }, { ...emptyDraft('github' as never), kind: 'watch', adapter: 'github', repo: 'a/b' }];
  const lines = wakeSummary('0 9 * * *', false, runtime);
  assert.equal(lines.length, 3);
  assert.equal(lines[0], 'Daily at 09:00');
  assert.match(lines[1], /^Plain-language schedule: weekdays at 9am/);
  assert.match(lines[2], /^Watch: GitHub a\/b/);
});

test('budget, rules, goals, learning and enforcement read as sentences', () => {
  const runtime = emptyRuntimeDraft();
  assert.equal(budgetSummary(runtime), '$5.00/day · $100/month · 12 wake-ups/hour');
  runtime.budget.draft = { dailyUsd: '', monthlyUsd: '', dailyActions: '', maxWakes: '', softPercent: '80' };
  assert.equal(budgetSummary(runtime), 'No limits set');
  runtime.budget.draft.dailyUsd = '50';
  runtime.budget.draft.monthlyUsd = '10';
  assert.match(budgetSummary(runtime), /^Not valid yet: .*daily spend limit is higher/);
  runtime.budget.enabled = false;
  assert.equal(budgetSummary(runtime), 'No limits set');

  assert.match(rulesSummary(emptyRuntimeDraft()), /^Safety floor only/);
  const rules = emptyRuntimeDraft();
  rules.rules = { allow: [{ server: 'mail', tool: 'reply', risk: 'send' }], neverDelete: true, neverPurchase: true };
  assert.equal(rulesSummary(rules), '1 tool allowed without asking (reply) · never delete · never purchase');

  assert.match(goalsSummary(emptyRuntimeDraft()), /^None yet/);
  const goals = emptyRuntimeDraft();
  goals.goals = [{ id: 'a', statement: ' One ', successCriteria: '', horizon: '' }, { id: 'b', statement: '', successCriteria: '', horizon: '' }, { id: 'c', statement: 'Two', successCriteria: '', horizon: '' }];
  assert.equal(goalsSummary(goals), 'One · Two');

  assert.match(learningSummary(emptyRuntimeDraft()), /nothing applies until you approve it/);
  const learning = emptyRuntimeDraft();
  learning.learning = { autoApply: true, minConfidence: 0.85 };
  assert.match(learningSummary(learning), /above 85% confidence apply automatically/);

  assert.equal(enforcementSummary('claude', null), 'Checking…');
  assert.equal(enforcementSummary('claude', 'enforced'), 'Enforced on claude');
  assert.match(enforcementSummary('codex', 'advisory'), /^Advisory on codex/);
  assert.match(enforcementSummary('claude', 'off'), /No gate/);
});

test('autonomy shows in the review, and the raw permission mode only when it matters', () => {
  const base = { cron: '0 * * * *', manualSchedule: false, provider: 'claude', globalChannels: [] };
  const careful = Object.fromEntries(runtimeReviewRows({ ...base, runtime: emptyRuntimeDraft(), enforcement: 'enforced', permissionMode: 'bypassPermissions' }));
  assert.match(careful.Autonomy, /^Careful/);
  assert.equal('Provider permission' in careful, false, 'an enforced provider hides the raw mode');
  const advisory = Object.fromEntries(runtimeReviewRows({ ...base, runtime: emptyRuntimeDraft(), enforcement: 'advisory', permissionMode: 'default' }));
  assert.match(advisory['Provider permission'], /^default: The provider asks before acting/);
  const loose = emptyRuntimeDraft();
  loose.autonomy = 'unrestricted';
  const unrestricted = Object.fromEntries(runtimeReviewRows({ ...base, runtime: loose, enforcement: 'off', permissionMode: 'bypassPermissions' }));
  assert.match(unrestricted.Autonomy, /no gate/);
  assert.match(unrestricted['Provider permission'], /bypassPermissions: The provider skips its own questions/);
  assert.match(unrestricted.Rules, /rules are never checked/);
  assert.match(unrestricted.Enforcement, /No gate/);
  const trusted = emptyRuntimeDraft();
  trusted.autonomy = 'trusted';
  assert.match(rulesSummary(trusted), /^Trusted: it acts on its own/);
  const unknown = Object.fromEntries(runtimeReviewRows({ ...base, runtime: emptyRuntimeDraft(), enforcement: null, permissionMode: 'default' }));
  assert.equal('Provider permission' in unknown, false);
});

test('the review rows cover every runtime choice', () => {
  const runtime = emptyRuntimeDraft();
  runtime.fallback = [{ provider: 'codex', model: 'm' }];
  runtime.watcher = { enabled: true, route: { provider: 'claude', model: 'haiku', effort: null } };
  const rows = runtimeReviewRows({ runtime, cron: '0 * * * *', manualSchedule: false, provider: 'claude', enforcement: 'advisory', globalChannels: [] });
  const byLabel = Object.fromEntries(rows);
  assert.deepEqual(rows.map(([label]) => label), ['Autonomy', 'More wake-ups', 'Goals', 'Rules', 'Budget', 'Enforcement', 'Backup providers', 'Triage model', 'Reaches you on', 'Learning']);
  assert.match(byLabel['More wake-ups'], /^None/);
  runtime.triggers = [{ ...emptyDraft('run_completed'), status: 'failed', enabled: false }];
  assert.equal(Object.fromEntries(runtimeReviewRows({ runtime, cron: '0 * * * *', manualSchedule: false, provider: 'claude', enforcement: 'advisory', globalChannels: [] }))['More wake-ups'], 'Run completed (off): Any run completes · status failed');
  assert.equal(byLabel['Backup providers'], 'claude → codex · m');
  assert.equal(byLabel['Triage model'], 'claude · haiku');
  assert.equal(byLabel['Reaches you on'], 'In-app notifications (always on)');
  const bare = Object.fromEntries(runtimeReviewRows({ runtime: emptyRuntimeDraft(), cron: null, manualSchedule: true, provider: 'claude', enforcement: null, globalChannels: [] }));
  assert.equal(bare['Backup providers'], 'None');
  assert.match(bare['Triage model'], /^Off/);
});
