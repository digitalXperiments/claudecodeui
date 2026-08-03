import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { missionControlDb } from '@/modules/mission-control/mission-control.repository.js';
import {
  ensureArticleStudioSections,
  ensureXArticlesSection,
} from '@/modules/mission-control/mission-control-seed.service.js';
import { ensureArticleStudioWorkspace } from '@/modules/mission-control/article-studio.service.js';
import { ARTICLE_STUDIO_MARKER } from '@/modules/mission-control/article-studio.templates.js';
import {
  buildSwipeDigestSectionInput,
  buildXArticlesSectionInput,
  SWIPE_DIGEST_SECTION_TITLE,
  X_ARTICLES_SECTION_TITLE,
} from '@/modules/mission-control/x-articles-seed.js';

async function withIsolatedDatabase(
  runTest: (workspace: string) => void | Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'x-articles-seed-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    await runTest(path.join(tempDirectory, 'x_articles'));
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('the studio scaffold writes the writing system and registers a project', async () => {
  await withIsolatedDatabase(async (workspace) => {
    const result = await ensureArticleStudioWorkspace(workspace);

    assert.equal(result.createdWorkspace, true);
    assert.ok(result.projectId, 'workspace was not registered as a project');
    assert.ok(result.files.every((f) => f.outcome === 'created'));

    // The pieces the produce prompt depends on must exist by these exact names.
    for (const relative of [
      'CLAUDE.md',
      'voice/voice.md',
      'patterns/patterns.md',
      'story-bank.md',
      '.claude/skills/story-angles/SKILL.md',
      '.claude/skills/hooks-and-titles/SKILL.md',
      '.claude/skills/article-structure/SKILL.md',
      '.claude/skills/fact-grounding/SKILL.md',
      '.claude/skills/swipe-analysis/SKILL.md',
    ]) {
      const contents = await readFile(path.join(workspace, relative), 'utf8');
      assert.ok(contents.length > 0, `${relative} is empty`);
    }

    // Skills must carry the frontmatter the skill discovery layer parses.
    const skill = await readFile(
      path.join(workspace, '.claude/skills/story-angles/SKILL.md'),
      'utf8',
    );
    assert.ok(skill.startsWith('---\n'), 'skill is missing frontmatter');
    assert.match(skill, /^name: story-angles$/m);
    assert.match(skill, /^description: .+$/m);
  });
});

test('re-scaffolding keeps our files and never touches user-owned ones', async () => {
  await withIsolatedDatabase(async (workspace) => {
    await ensureArticleStudioWorkspace(workspace);

    // The user rewrites the voice spec and drops our marker line.
    const voicePath = path.join(workspace, 'voice/voice.md');
    const mine = '# Voice\n\nI write like me, thanks.\n';
    await writeFile(voicePath, mine, 'utf8');

    const second = await ensureArticleStudioWorkspace(workspace);

    assert.equal(second.createdWorkspace, false);
    const voice = second.files.find((f) => f.path === 'voice/voice.md');
    assert.equal(voice?.outcome, 'user-owned');
    assert.equal(await readFile(voicePath, 'utf8'), mine, 'user edits were overwritten');

    // Untouched files still carry our marker and are left as-is.
    const claude = second.files.find((f) => f.path === 'CLAUDE.md');
    assert.equal(claude?.outcome, 'kept');
    assert.match(await readFile(path.join(workspace, 'CLAUDE.md'), 'utf8'), /cloudcli:article-studio/);
  });
});

test('a stale template is upgraded in place', async () => {
  await withIsolatedDatabase(async (workspace) => {
    await ensureArticleStudioWorkspace(workspace);

    // Simulate a file written by an older template version.
    const target = path.join(workspace, 'story-bank.md');
    await writeFile(target, `<!-- ${ARTICLE_STUDIO_MARKER} v0 -->\nold\n`, 'utf8');

    const second = await ensureArticleStudioWorkspace(workspace);
    assert.equal(second.files.find((f) => f.path === 'story-bank.md')?.outcome, 'upgraded');
    assert.doesNotMatch(await readFile(target, 'utf8'), /^old$/m);
  });
});

test('both article sections seed against the studio project', async () => {
  await withIsolatedDatabase(async (workspace) => {
    const result = await ensureArticleStudioSections(workspace);

    assert.equal(result.sections.length, 2);
    const titles = result.sections.map((s) => s.title);
    assert.ok(titles.includes(X_ARTICLES_SECTION_TITLE));
    assert.ok(titles.includes(SWIPE_DIGEST_SECTION_TITLE));

    for (const section of result.sections) {
      assert.equal(section.scope, 'project');
      assert.equal(
        section.project_id,
        result.projectId,
        `${section.title} is not bound to the studio project`,
      );
    }

    // Idempotent.
    const again = await ensureArticleStudioSections(workspace);
    assert.equal(again.projectId, result.projectId);
    assert.equal(
      missionControlDb.listSections().filter((s) => s.title === X_ARTICLES_SECTION_TITLE).length,
      1,
    );
  });
});

test('a section pointed at a stale project is re-bound to the studio', async () => {
  await withIsolatedDatabase(async (workspace) => {
    const first = await ensureArticleStudioSections(workspace);
    const section = first.sections.find((s) => s.title === X_ARTICLES_SECTION_TITLE)!;

    // Simulate the studio moving: the section still points at the old project.
    missionControlDb.updateSection(section.section_id, {
      scope: 'global',
      project_id: null,
      provider: 'grok',
      schedule_cron: '0 7 * * 3',
      enabled: false,
    });

    const rebound = ensureXArticlesSection(first.projectId);
    assert.equal(rebound.updated, true);
    assert.equal(rebound.section.scope, 'project');
    assert.equal(rebound.section.project_id, first.projectId);

    // User tuning survives the re-bind.
    assert.equal(rebound.section.provider, 'grok');
    assert.equal(rebound.section.schedule_cron, '0 7 * * 3');
    assert.equal(rebound.section.enabled, false);
  });
});

test('drafting section runs in the studio and never auto-approves', () => {
  const input = buildXArticlesSectionInput('project-123');
  assert.equal(input.scope, 'project');
  assert.equal(input.project_id, 'project-123');
  assert.equal(input.auto_approve, false, 'prose must always be human-reviewed');
  assert.equal(input.create_kanban_task, false);
  assert.equal(input.mode, 'review');

  const polish = input.actions?.find((a) => a.id === 'polish');
  assert.equal(polish?.terminal, false, 'polish must rewrite in place');
  assert.ok(input.actions?.some((a) => a.kind === 'delete'));
});

test('the produce prompt loads the writing system before writing', () => {
  const { produce_prompt: prompt } = buildXArticlesSectionInput('p1');

  // Order matters: the studio files are step 0, ahead of any drafting.
  assert.ok(prompt?.includes('voice/voice.md'));
  assert.ok(prompt?.includes('patterns/patterns.md'));
  assert.ok(prompt?.includes('story-bank.md'));
  for (const skill of ['story-angles', 'hooks-and-titles', 'article-structure', 'fact-grounding']) {
    assert.ok(prompt?.includes(skill), `prompt never invokes the ${skill} skill`);
  }

  // Story-shaped, not gotcha-shaped.
  assert.ok(prompt?.includes('story of building it'));
  assert.ok(prompt?.includes('titleVariants'));
  assert.ok(prompt?.includes('"kind": "x_article"'), 'body contract drifted from the renderer');
  assert.ok(prompt?.includes('"dedupeKey": "x-article:<slug>"'));
});

test('swipe digest reads Clippings and refuses to invent patterns', () => {
  const input = buildSwipeDigestSectionInput('p1');
  assert.equal(input.mode, 'fire_and_forget');
  assert.equal(input.scope, 'project');
  assert.deepEqual(input.produce_tools, ['obsidian']);

  const prompt = input.produce_prompt ?? '';
  assert.ok(prompt.includes('Clippings/'));
  assert.ok(prompt.includes('swipe-analysis'));
  // An empty swipe file must not produce invented "patterns".
  assert.ok(prompt.includes('write nothing'));
  assert.ok(prompt.includes("author's own notes") || prompt.includes('divider'));
});

test('scaffolding tolerates a pre-existing directory with unrelated files', async () => {
  await withIsolatedDatabase(async (workspace) => {
    await mkdir(path.join(workspace, 'drafts'), { recursive: true });
    await writeFile(path.join(workspace, 'drafts', 'notes.md'), 'mine', 'utf8');

    const result = await ensureArticleStudioWorkspace(workspace);
    assert.equal(result.createdWorkspace, false);
    assert.equal(await readFile(path.join(workspace, 'drafts', 'notes.md'), 'utf8'), 'mine');
  });
});
