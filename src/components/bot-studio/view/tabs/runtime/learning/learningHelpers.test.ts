import assert from 'node:assert/strict';
import test from 'node:test';

import type { BotProposal, BotSkill } from '../../../../types/botRuntime';

import {
  canEditProposalBody,
  canPurge,
  confidencePercent,
  confidenceTone,
  evidenceRefs,
  exportFilename,
  parseSafeFields,
  parseSafeSteps,
  proposalCounts,
  proposalFloorWarning,
  proposalsForTab,
  purgePhrase,
  purgeSummary,
  ruleProposalSummary,
  selectedPurgeKeys,
  skillContentProblem,
  skillTemplate,
  slugifySkillName,
  sortSkills,
  validateProfileEntry,
  validateSkillName,
} from './learningHelpers';

const proposal = (overrides: Partial<BotProposal> = {}): BotProposal => ({
  proposal_id: 'p1', bot_id: 'b1', kind: 'memory', title: 't', body: 'b', payload: {}, evidence: [], confidence: 0.6,
  status: 'proposed', created_at: '', decided_at: null, ...overrides,
});

test('proposals group into tabs (applied counts as approved, superseded as rejected)', () => {
  const list = [
    proposal({ proposal_id: 'a' }),
    proposal({ proposal_id: 'b', status: 'approved' }),
    proposal({ proposal_id: 'c', status: 'applied' }),
    proposal({ proposal_id: 'd', status: 'rejected' }),
    proposal({ proposal_id: 'e', status: 'superseded' }),
  ];
  assert.deepEqual(proposalsForTab(list, 'approved').map((p) => p.proposal_id), ['b', 'c']);
  assert.deepEqual(proposalsForTab(list, 'rejected').map((p) => p.proposal_id), ['d', 'e']);
  assert.deepEqual(proposalCounts(list), { proposed: 1, approved: 2, rejected: 2 });
});

test('only text proposals are editable before approval', () => {
  assert.equal(canEditProposalBody('memory'), true);
  assert.equal(canEditProposalBody('new_skill'), true);
  assert.equal(canEditProposalBody('skill_patch'), true);
  assert.equal(canEditProposalBody('rule'), false);
});

test('confidence maps to a clamped percent and a tone', () => {
  assert.equal(confidencePercent(0.654), 65);
  assert.equal(confidencePercent(2), 100);
  assert.equal(confidencePercent(Number.NaN), 0);
  assert.equal(confidenceTone(0.9), 'high');
  assert.equal(confidenceTone(0.5), 'medium');
  assert.equal(confidenceTone(0.2), 'low');
});

test('rule proposals with payload.floor warn and summarize', () => {
  const rule = proposal({ kind: 'rule', payload: { server: 'gmail', tool: 'send_email', risk: 'send', floor: true, expires_days: 30 } });
  assert.match(proposalFloorWarning(rule) ?? '', /run send actions on gmail without asking/);
  assert.equal(ruleProposalSummary(rule), 'Allow gmail · send_email (send) for 30 days');
  assert.equal(proposalFloorWarning(proposal({ kind: 'rule', payload: { server: 'a', tool: 'b', floor: false } })), null);
  assert.equal(proposalFloorWarning(proposal({ kind: 'memory', payload: { floor: true } })), null);
  assert.equal(ruleProposalSummary(proposal()), null);
  assert.equal(ruleProposalSummary(proposal({ kind: 'rule', payload: {} })), null);
});

test('evidenceRefs classifies against known ids and dedupes', () => {
  const refs = evidenceRefs(['ep-1234567890', 'dec-1', 'item-9', 'ep-1234567890', 42, ''], { episodes: ['ep-1234567890'], decisions: ['dec-1'] });
  assert.deepEqual(refs, [
    { id: 'ep-1234567890', kind: 'episode', short: 'ep-12345…' },
    { id: 'dec-1', kind: 'decision', short: 'dec-1' },
    { id: 'item-9', kind: 'item', short: 'item-9' },
  ]);
  assert.deepEqual(evidenceRefs([]), []);
});

test('skill names follow the server slug rule', () => {
  assert.equal(validateSkillName('jira-triage'), null);
  assert.match(validateSkillName('') ?? '', /name/);
  assert.match(validateSkillName('Jira Triage') ?? '', /lowercase/);
  assert.match(validateSkillName('-x') ?? '', /lowercase/);
  assert.equal(slugifySkillName('  Jira Triage!  '), 'jira-triage');
  assert.equal(validateSkillName(slugifySkillName('x'.repeat(100))), null);
  assert.equal(slugifySkillName('???'), '');
});

test('skill content checks emptiness and size; template carries the name', () => {
  assert.match(skillContentProblem('  ') ?? '', /content/);
  assert.equal(skillContentProblem('# ok'), null);
  assert.match(skillContentProblem('x'.repeat(64 * 1024 + 1)) ?? '', /64 KB/);
  assert.match(skillTemplate('my-skill'), /^---\nname: my-skill\n/);
});

test('sortSkills lists enabled first then by name', () => {
  const skill = (name: string, enabled: boolean): BotSkill => ({ link_id: name, bot_id: 'b', name, path: '', origin: 'manual', version: 1, enabled, created_at: '', updated_at: '', description: '', readonly: false });
  assert.deepEqual(sortSkills([skill('b', false), skill('z', true), skill('a', true)]).map((s) => s.name), ['a', 'z', 'b']);
});

test('teach safe-list parsing', () => {
  assert.deepEqual(parseSafeFields('#search, input[name=q]\n#search'), ['#search', 'input[name=q]']);
  assert.deepEqual(parseSafeSteps('1, 3 3'), [1, 3]);
  assert.deepEqual(parseSafeSteps(''), []);
  assert.deepEqual(parseSafeSteps('0'), { error: '"0" is not a step number (use 1, 2, 3...).' });
  assert.deepEqual(parseSafeSteps('a'), { error: '"a" is not a step number (use 1, 2, 3...).' });
});

test('operator profile validation', () => {
  assert.equal(validateProfileEntry('Jira comments', 'use bullets'), null);
  assert.match(validateProfileEntry('', 'x') ?? '', /key/);
  assert.match(validateProfileEntry('bad:key', 'x') ?? '', /key/);
  assert.match(validateProfileEntry('k', '  ') ?? '', /value/);
  assert.match(validateProfileEntry('k', 'x'.repeat(501)) ?? '', /500/);
});

test('purge needs a selection and the exact typed phrase', () => {
  const phrase = purgePhrase(' Jira Triage ');
  assert.equal(phrase, 'Jira Triage');
  assert.equal(purgePhrase('  '), 'purge');
  assert.equal(canPurge({}, 'Jira Triage', phrase), false);
  assert.equal(canPurge({ memories: true }, 'jira triage', phrase), false);
  assert.equal(canPurge({ memories: true }, ' Jira Triage ', phrase), true);
  assert.equal(canPurge({ memories: false }, 'Jira Triage', phrase), false);
  assert.deepEqual(selectedPurgeKeys({ skills: true, events: true, memories: false }), ['events', 'skills']);
  assert.equal(purgeSummary({ memories: 3, episodes: 0, events: 12, threads: 0, proposals: 0, skills: 0 }), 'Deleted 3 memories, 12 events.');
  assert.equal(purgeSummary({ memories: 0, episodes: 0, events: 0, threads: 0, proposals: 0, skills: 0 }), 'Nothing matched; no data was deleted.');
});

test('exportFilename is filesystem safe', () => {
  assert.equal(exportFilename('bot/1 x', new Date('2026-10-01T10:00:00Z')), 'bot-bot-1-x-export-2026-10-01.json');
});
