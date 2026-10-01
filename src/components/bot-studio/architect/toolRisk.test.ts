import assert from 'node:assert/strict';
import test from 'node:test';

import {
  allowRuleInput, denyRiskRuleInput, describeAllowChoice, escapeGlobLiteral, floorItemsByServer, isAllowed,
  isObviouslyReadTool, pruneAllow, toRiskItem, toggleAllow, type ToolRiskItem,
} from './toolRisk';

test('only tools whose first word reads are skipped by the classifier round trip', () => {
  for (const name of ['get_thread', 'listIssues', 'list-issues', 'Search_Messages', 'read', 'fetch_url']) assert.equal(isObviouslyReadTool(name), true, name);
  for (const name of ['send_message', 'listen_and_send', 'gmail_get_thread', 'getter_of_things', 'delete_file', '']) assert.equal(isObviouslyReadTool(name), false, name);
});

const item = (server: string, tool: string, risk: string, floor = true): ToolRiskItem => ({ server, tool, risk: risk as ToolRiskItem['risk'], floor });

test('floor tools are grouped by server in a stable order and everything else is hidden', () => {
  const groups = floorItemsByServer([item('mail', 'send_message', 'send'), item('mail', 'reply', 'send'), item('docs', 'update_doc', 'draft', false), item('cal', 'delete_event', 'delete')]);
  assert.deepEqual(groups.map((group) => group.server), ['cal', 'mail']);
  assert.deepEqual(groups[1].items.map((entry) => entry.tool), ['reply', 'send_message']);
});

test('toggling an allow choice adds, replaces and removes without touching others', () => {
  let allow = toggleAllow([], item('mail', 'send_message', 'send'), true);
  allow = toggleAllow(allow, item('mail', 'reply', 'send'), true);
  assert.equal(isAllowed(allow, 'mail', 'reply'), true);
  allow = toggleAllow(allow, item('mail', 'send_message', 'send'), true);
  assert.equal(allow.length, 2, 'no duplicates');
  allow = toggleAllow(allow, item('mail', 'send_message', 'send'), false);
  assert.deepEqual(allow, [{ server: 'mail', tool: 'reply', risk: 'send' }]);
  assert.deepEqual(pruneAllow(allow, ['other']), []);
  assert.deepEqual(pruneAllow(allow, ['mail']), allow);
});

test('an allow rule is bot-scoped, names exactly one tool and carries its risk', () => {
  const rule = allowRuleInput({ server: 'claude.ai Gmail', tool: 'send_message', risk: 'send' });
  assert.equal(rule.scope, 'bot');
  assert.equal(rule.decision, 'allow');
  assert.deepEqual(rule.match, { server: 'claude.ai Gmail', tool: 'send_message', risk: ['send'] });
  assert.match(rule.note ?? '', /Bot Architect/);
  assert.equal('botId' in rule, false, 'the bot id is added once the bot exists');
});

test('glob characters in a tool name are matched literally', () => {
  assert.equal(escapeGlobLiteral('a*b\\c'), 'a\\*b\\\\c');
  assert.equal(allowRuleInput({ server: 's', tool: 'run*', risk: 'prod_change' }).match?.tool, 'run\\*');
});

test('never-delete and never-purchase are deny rules that outrank allows', () => {
  const del = denyRiskRuleInput('delete');
  assert.equal(del.decision, 'deny');
  assert.deepEqual(del.match, { risk: ['delete'] });
  assert.ok((del.priority ?? 0) > 0);
  assert.deepEqual(denyRiskRuleInput('purchase').match, { risk: ['purchase'] });
});

test('checkbox labels say what the tool does in words', () => {
  assert.equal(describeAllowChoice({ tool: 'send_message', risk: 'send' }), 'send_message (sends a message)');
  assert.equal(describeAllowChoice({ tool: 'x', risk: 'credential' }), 'x (touches credentials)');
});

test('a classifier answer becomes a risk item', () => {
  assert.deepEqual(toRiskItem('mail', { name: 'send', description: 'Send' }, { risk: 'send', floor: true, default_decision: 'ask' }), { server: 'mail', tool: 'send', description: 'Send', risk: 'send', floor: true });
  assert.equal('description' in toRiskItem('mail', { name: 'send' }, { risk: 'read', floor: false, default_decision: 'allow' }), false);
});
