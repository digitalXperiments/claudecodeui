import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EDITOR_STATE_HEADING,
  buildEditBrief,
  extractSkillDraft,
  stripEditorState,
  withEditorState,
} from './skillWizardPrompt';

const SKILL = ['---', 'name: pr-review', 'description: Review a PR when asked.', '---', '', '# PR review'].join('\n');

test('buildEditBrief embeds the current skill and names it', () => {
  const brief = buildEditBrief({ skillName: 'pr-review', content: SKILL });
  assert.ok(brief.includes('`pr-review`'));
  assert.ok(brief.includes(EDITOR_STATE_HEADING));
  assert.ok(brief.includes('name: pr-review'));
  // The agent must not try to edit files itself — the dialog owns saving.
  assert.ok(/do NOT read, write, or search files/.test(brief));
});

test('buildEditBrief works without a skill name', () => {
  const brief = buildEditBrief({ content: SKILL });
  assert.ok(!brief.includes('The skill is'));
  assert.ok(brief.includes(EDITOR_STATE_HEADING));
});

test('withEditorState/stripEditorState round-trip the visible turn', () => {
  const payload = withEditorState('tighten step 3', SKILL);
  assert.ok(payload.includes(SKILL));
  assert.equal(stripEditorState(payload), 'tighten step 3');
  assert.equal(stripEditorState('no state appended'), 'no state appended');
});

test('a revision emitted against the brief is extractable', () => {
  const reply = ['Updated.', '', '```markdown', SKILL, '```'].join('\n');
  const draft = extractSkillDraft(reply);
  assert.equal(draft?.name, 'pr-review');
  assert.equal(draft?.content.trim(), SKILL.trim());
});
