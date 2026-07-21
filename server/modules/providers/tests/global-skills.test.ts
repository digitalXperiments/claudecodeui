import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { globalSkillsService } from '@/modules/providers/services/global-skills.service.js';
import {
  buildMemorySkillContent,
  MEMORY_SKILL_DIRECTORY_NAME,
  MEMORY_SKILL_VAULT_FOLDER_TOKEN,
} from '@/modules/providers/shared/memory/memory-skill.template.js';

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

const FAN_OUT_ROOTS = ['.claude', '.agents', '.cursor', '.grok', '.kimi-code'] as const;

/**
 * Global skills are authored once and fanned out to every agent's user-scope
 * skill directory (`~/.claude/skills`, `~/.agents/skills`, `~/.cursor/skills`,
 * `~/.grok/skills`, `~/.kimi-code/skills`) so they apply to all projects.
 */
test('globalSkillsService fans one skill out to every agent user folder', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-global-skills-'));

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    const created = await globalSkillsService.addGlobalSkills({
      entries: [
        {
          directoryName: 'shared-global',
          content: '---\nname: shared-global\ndescription: A cross-agent global skill\n---\n\nBody.\n',
        },
      ],
    });

    const skill = created[0];
    assert.ok(skill);
    assert.equal(skill.directoryName, 'shared-global');
    assert.deepEqual([...skill.providers].sort(), ['claude', 'codex', 'cursor', 'grok', 'kimi']);
    assert.deepEqual(skill.conflicts, []);
    assert.deepEqual([...skill.unsupported].sort(), ['agy', 'opencode']);

    // Canonical master copy.
    assert.equal(
      await pathExists(path.join(tempRoot, '.cloudcli', 'skills', 'shared-global', 'SKILL.md')),
      true,
    );
    // Fanned-out agent copies.
    for (const root of FAN_OUT_ROOTS) {
      assert.equal(
        await pathExists(path.join(tempRoot, root, 'skills', 'shared-global', 'SKILL.md')),
        true,
        `expected fan-out copy under ${root}`,
      );
    }

    const listed = await globalSkillsService.listGlobalSkills();
    const listedSkill = listed.find((entry) => entry.directoryName === 'shared-global');
    assert.ok(listedSkill);
    assert.deepEqual([...listedSkill.providers].sort(), ['claude', 'codex', 'cursor', 'grok', 'kimi']);

    const removed = await globalSkillsService.removeGlobalSkill({ directoryName: 'shared-global' });
    assert.equal(removed.removed, true);
    for (const root of FAN_OUT_ROOTS) {
      assert.equal(await pathExists(path.join(tempRoot, root, 'skills', 'shared-global')), false);
    }
    assert.equal(await pathExists(path.join(tempRoot, '.cloudcli', 'skills', 'shared-global')), false);
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
test('globalSkillsService skips agent folders with a pre-existing non-managed skill', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-global-skills-conflict-'));
  const handAuthoredDir = path.join(tempRoot, '.claude', 'skills', 'shared-global');
  await fs.mkdir(handAuthoredDir, { recursive: true });
  const handAuthoredPath = path.join(handAuthoredDir, 'SKILL.md');
  await fs.writeFile(handAuthoredPath, '---\nname: hand-authored\ndescription: Do not overwrite\n---\n\nKeep me.\n', 'utf8');

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    const created = await globalSkillsService.addGlobalSkills({
      entries: [
        {
          directoryName: 'shared-global',
          content: '---\nname: shared-global\ndescription: A cross-agent global skill\n---\n\nBody.\n',
        },
      ],
    });

    const skill = created[0];
    assert.ok(skill);
    assert.equal(skill.conflicts.includes('claude'), true);
    assert.equal(skill.providers.includes('claude'), false);
    assert.equal(skill.providers.includes('kimi'), true);

    // The hand-authored skill is preserved untouched.
    assert.match(await fs.readFile(handAuthoredPath, 'utf8'), /Keep me\./);

    // Removal must not delete the hand-authored (non-managed) Claude folder.
    await globalSkillsService.removeGlobalSkill({ directoryName: 'shared-global' });
    assert.equal(await pathExists(handAuthoredPath), true);
    assert.equal(await pathExists(path.join(tempRoot, '.kimi-code', 'skills', 'shared-global')), false);
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * The reserved project-memory directory is seeded as an editable template: it
 * shows up first in listings, is never fanned out, and cannot be installed or
 * removed through the normal skill paths.
 */
test('globalSkillsService manages the memory skill template', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-global-skills-memory-'));

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    const listed = await globalSkillsService.listGlobalSkills();
    const template = listed.find((entry) => entry.directoryName === MEMORY_SKILL_DIRECTORY_NAME);
    assert.ok(template);
    assert.equal(template.kind, 'memory-template');
    assert.equal(listed[0]?.directoryName, MEMORY_SKILL_DIRECTORY_NAME);

    // Seeded on disk but never fanned out to agent folders.
    assert.equal(
      await pathExists(path.join(tempRoot, '.cloudcli', 'skills', MEMORY_SKILL_DIRECTORY_NAME, 'SKILL.md')),
      true,
    );
    for (const root of FAN_OUT_ROOTS) {
      assert.equal(
        await pathExists(path.join(tempRoot, root, 'skills', MEMORY_SKILL_DIRECTORY_NAME)),
        false,
      );
    }

    await assert.rejects(
      () => globalSkillsService.removeGlobalSkill({ directoryName: MEMORY_SKILL_DIRECTORY_NAME }),
      (error: unknown) => (error as { code?: string }).code === 'GLOBAL_SKILL_MANAGED',
    );

    await assert.rejects(
      () => globalSkillsService.addGlobalSkills({
        entries: [{ directoryName: MEMORY_SKILL_DIRECTORY_NAME, content: '---\nname: project-memory\n---\n\nNope.\n' }],
      }),
      (error: unknown) => (error as { code?: string }).code === 'GLOBAL_SKILL_MANAGED',
    );

    // Editing the template writes the canonical copy only.
    const customTemplate = `---\nname: project-memory\ndescription: Custom\n---\n\nCustom contract for ${MEMORY_SKILL_VAULT_FOLDER_TOKEN}.\n`;
    await globalSkillsService.updateGlobalSkillContent({
      directoryName: MEMORY_SKILL_DIRECTORY_NAME,
      content: customTemplate,
    });
    const active = await globalSkillsService.getMemorySkillTemplate();
    assert.match(active, /Custom contract/);
    assert.equal(await globalSkillsService.getMemorySkillTemplate(), `${customTemplate.trim()}\n`);
    for (const root of FAN_OUT_ROOTS) {
      assert.equal(
        await pathExists(path.join(tempRoot, root, 'skills', MEMORY_SKILL_DIRECTORY_NAME)),
        false,
      );
    }
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * Editing a global skill rewrites the canonical copy and every installed agent
 * copy in place, preserving supporting files.
 */
test('globalSkillsService.updateGlobalSkillContent rewrites all copies and keeps supporting files', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-global-skills-edit-'));

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    await globalSkillsService.addGlobalSkills({
      entries: [
        {
          directoryName: 'editable',
          content: '---\nname: editable\ndescription: Before\n---\n\nOriginal body.\n',
          files: [{ relativePath: 'scripts/run.sh', content: '#!/bin/sh\necho hi\n', encoding: 'utf8' }],
        },
      ],
    });

    const updated = '---\nname: editable\ndescription: After\n---\n\nUpdated body.\n';
    await globalSkillsService.updateGlobalSkillContent({ directoryName: 'editable', content: updated });

    const canonicalPath = path.join(tempRoot, '.cloudcli', 'skills', 'editable', 'SKILL.md');
    assert.equal(await fs.readFile(canonicalPath, 'utf8'), `${updated.trim()}\n`);
    assert.equal(
      await fs.readFile(path.join(tempRoot, '.claude', 'skills', 'editable', 'SKILL.md'), 'utf8'),
      `${updated.trim()}\n`,
    );
    assert.equal(
      await fs.readFile(path.join(tempRoot, '.kimi-code', 'skills', 'editable', 'SKILL.md'), 'utf8'),
      `${updated.trim()}\n`,
    );

    // Supporting files survive the edit in both the canonical and agent copies.
    assert.equal(await pathExists(path.join(tempRoot, '.cloudcli', 'skills', 'editable', 'scripts', 'run.sh')), true);
    assert.equal(await pathExists(path.join(tempRoot, '.claude', 'skills', 'editable', 'scripts', 'run.sh')), true);

    // Invalid content is rejected before anything is written.
    await assert.rejects(
      () => globalSkillsService.updateGlobalSkillContent({ directoryName: 'editable', content: '   ' }),
      (error: unknown) => (error as { code?: string }).code === 'PROVIDER_SKILL_CONTENT_REQUIRED',
    );
    assert.match(await fs.readFile(canonicalPath, 'utf8'), /Updated body\./);
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * The built-in template renders through the token and stays compatible with
 * the legacy buildMemorySkillContent output shape.
 */
test('memory skill template renders the vault folder via token replacement', () => {
  const rendered = buildMemorySkillContent('Projects/demo');
  assert.match(rendered, /^---\nname: project-memory\n/);
  assert.match(rendered, /`Projects\/demo\/00-Overview\.md`/);
  assert.equal(rendered.includes(MEMORY_SKILL_VAULT_FOLDER_TOKEN), false);
});
