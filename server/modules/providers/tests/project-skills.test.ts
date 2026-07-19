import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { projectSkillsService } from '@/modules/providers/services/project-skills.service.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

const pathExists = async (target: string): Promise<boolean> => {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
};

/**
 * Project skills are authored once and fanned out to every agent's project
 * skill directory. `.claude/skills` (Claude), `.agents/skills` (Codex, Cursor,
 * Grok), and `.kimi-code/skills` (Kimi) should each receive a copy.
 */
test('projectSkillsService fans one skill out to every agent project folder', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-project-skills-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    const created = await projectSkillsService.addProjectSkills({
      workspacePath,
      entries: [
        {
          directoryName: 'shared-skill',
          content: '---\nname: shared-skill\ndescription: A cross-agent skill\n---\n\nBody.\n',
        },
      ],
    });

    const skill = created[0];
    assert.ok(skill);
    assert.equal(skill.directoryName, 'shared-skill');
    assert.deepEqual([...skill.providers].sort(), ['claude', 'codex', 'cursor', 'grok', 'kimi']);
    assert.deepEqual(skill.conflicts, []);

    // Canonical master copy.
    assert.equal(
      await pathExists(path.join(workspacePath, '.cloudcli', 'skills', 'shared-skill', 'SKILL.md')),
      true,
    );
    // Fanned-out agent copies.
    assert.equal(await pathExists(path.join(workspacePath, '.claude', 'skills', 'shared-skill', 'SKILL.md')), true);
    assert.equal(await pathExists(path.join(workspacePath, '.agents', 'skills', 'shared-skill', 'SKILL.md')), true);
    assert.equal(await pathExists(path.join(workspacePath, '.kimi-code', 'skills', 'shared-skill', 'SKILL.md')), true);

    const listed = await projectSkillsService.listProjectSkills({ workspacePath });
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.name, 'shared-skill');
    assert.deepEqual([...(listed[0]?.providers ?? [])].sort(), ['claude', 'codex', 'cursor', 'grok', 'kimi']);

    const removed = await projectSkillsService.removeProjectSkill({ workspacePath, directoryName: 'shared-skill' });
    assert.equal(removed.removed, true);
    assert.equal(await pathExists(path.join(workspacePath, '.claude', 'skills', 'shared-skill')), false);
    assert.equal(await pathExists(path.join(workspacePath, '.agents', 'skills', 'shared-skill')), false);
    assert.equal(await pathExists(path.join(workspacePath, '.kimi-code', 'skills', 'shared-skill')), false);
    assert.equal(await pathExists(path.join(workspacePath, '.cloudcli', 'skills', 'shared-skill')), false);
    assert.equal((await projectSkillsService.listProjectSkills({ workspacePath })).length, 0);
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * A hand-authored per-agent skill of the same name must not be clobbered. The
 * target folder that already holds a non-managed skill is reported as a
 * conflict and left untouched.
 */
test('projectSkillsService skips agent folders with a pre-existing non-managed skill', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-project-skills-conflict-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const handAuthoredDir = path.join(workspacePath, '.claude', 'skills', 'shared-skill');
  await fs.mkdir(handAuthoredDir, { recursive: true });
  const handAuthoredPath = path.join(handAuthoredDir, 'SKILL.md');
  await fs.writeFile(handAuthoredPath, '---\nname: hand-authored\ndescription: Do not overwrite\n---\n\nKeep me.\n', 'utf8');

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    const created = await projectSkillsService.addProjectSkills({
      workspacePath,
      entries: [
        {
          directoryName: 'shared-skill',
          content: '---\nname: shared-skill\ndescription: A cross-agent skill\n---\n\nBody.\n',
        },
      ],
    });

    const skill = created[0];
    assert.ok(skill);
    // Claude's folder is a conflict; the shared .agents folder (codex/cursor/grok) and kimi still receive it.
    assert.equal(skill.conflicts.includes('claude'), true);
    assert.equal(skill.providers.includes('claude'), false);
    assert.equal(skill.providers.includes('codex'), true);
    assert.equal(skill.providers.includes('kimi'), true);

    // The hand-authored skill is preserved untouched.
    assert.match(await fs.readFile(handAuthoredPath, 'utf8'), /Keep me\./);

    // Removal must not delete the hand-authored (non-managed) Claude folder.
    await projectSkillsService.removeProjectSkill({ workspacePath, directoryName: 'shared-skill' });
    assert.equal(await pathExists(handAuthoredPath), true);
    assert.equal(await pathExists(path.join(workspacePath, '.agents', 'skills', 'shared-skill')), false);
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
