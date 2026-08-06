import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { providerRegistry } from '@/modules/providers/provider.registry.js';
import {
  prepareSkillInstall,
  writeSkillInstall,
} from '@/modules/providers/shared/skills/skills.materialize.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import {
  chatRunRegistry,
  DETACHED_CONNECTION,
  startProviderRun,
  type ProviderSpawnFn,
} from '@/modules/websocket/index.js';
import type { LLMProvider } from '@/shared/types.js';
import {
  AppError,
  readProviderSkillMarkdownDefinitionFromContent,
} from '@/shared/utils.js';

/**
 * Headless dry-run testing of a drafted skill.
 *
 * The wizard's draft is materialized into a throwaway scratch project under
 * `tmp/cloudcli/`, then a detached (no websocket/human) provider run is asked
 * to load and describe the skill. The scratch project is removed in a finally
 * regardless of the run's outcome, so a dry run never leaks files into the
 * real workspace or agent skill folders.
 *
 * Provider runtimes are injected once at server boot from the same `spawnFns`
 * map the websocket server uses (see the kanban/mission-control pattern), so
 * this service stays decoupled from index.js wiring.
 */
let runtimeSpawnFns: Partial<Record<LLMProvider, ProviderSpawnFn>> = {};

export function configureSkillTestRuntimes(
  spawnFns: Partial<Record<LLMProvider, ProviderSpawnFn>>,
): void {
  runtimeSpawnFns = spawnFns;
}

export function getSkillTestSpawnFn(provider: LLMProvider): ProviderSpawnFn {
  const spawnFn = runtimeSpawnFns[provider];
  if (!spawnFn) {
    throw new AppError('Skill test runtime not configured', {
      code: 'SKILL_TEST_RUNTIME_NOT_CONFIGURED',
      statusCode: 503,
    });
  }
  return spawnFn;
}

export type SkillTestResult = {
  success: boolean;
  text: string;
  errorMessage?: string;
  durationMs: number;
  scratchPath: string;
  cleanedUp: boolean;
};

const DEFAULT_TEST_PROMPT = (name: string): string => (
  `You are a QA harness testing the skill named "${name}".\n\n`
  + `1. Load the skill "${name}".\n`
  + '2. Report its frontmatter description verbatim.\n'
  + '3. In 2-3 sentences summarize what the skill instructs an agent to do.\n'
  + '4. List its step count / key sections.\n\n'
  + 'Be concise. This is a dry run — do not modify any files.'
);

const toKebabSlug = (name: string): string => (
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
    .slice(0, 48) || 'test-skill'
);

type TestRunOutcome = {
  /** Assistant text output (error events are NOT mixed in). */
  text: string;
  /**
   * True when the run's terminal `complete` carried a non-zero exit code —
   * i.e. the provider runtime itself failed (API unreachable, CLI crash, …).
   * Mid-run `error`-kind events alone do NOT mark failure: some providers
   * forward benign stderr noise under that kind while the run still succeeds.
   */
  failed: boolean;
  /** Provider error text (error-kind events), when present. */
  errorMessage: string | null;
};

/** Local copy of mission-control's extractRunOutcome — kept local to avoid cross-module coupling. */
function extractRunOutcome(appSessionId: string): TestRunOutcome {
  const events = chatRunRegistry.replayEvents(appSessionId, 0);
  const textChunks: string[] = [];
  const deltaChunks: string[] = [];
  const errorChunks: string[] = [];
  let failed = false;
  for (const event of events) {
    if (event.kind === 'complete') {
      if (typeof event.exitCode === 'number' && event.exitCode !== 0) {
        failed = true;
      }
      continue;
    }
    if (typeof event.content !== 'string') {
      continue;
    }
    if (event.kind === 'error') {
      errorChunks.push(event.content);
    } else if (event.kind === 'text') {
      textChunks.push(event.content);
    } else if (event.kind === 'stream_delta') {
      deltaChunks.push(event.content);
    }
  }
  return {
    text: (textChunks.length > 0 ? textChunks.join('\n') : deltaChunks.join('')).trim(),
    failed,
    errorMessage: errorChunks.join('\n').trim() || null,
  };
}

/**
 * Runs a headless dry-run test of a drafted skill for one provider.
 *
 * The draft's SKILL.md is materialized into a scratch project's provider skill
 * folder (via the same project-scope target resolution the fan-out services
 * use), then a detached agent run is pointed at that scratch project and asked
 * to load the skill. The scratch directory lives under
 * `<workspace>/tmp/cloudcli/` (or `<cwd>/tmp/cloudcli/` without a workspace)
 * and is always removed in a finally.
 */
export async function testSkill(params: {
  provider: LLMProvider;
  content: string;
  workspacePath?: string | null;
  testPrompt?: string;
}): Promise<SkillTestResult> {
  const { provider, content } = params;
  const startedAt = Date.now();

  const root = params.workspacePath
    ? path.join(params.workspacePath, 'tmp', 'cloudcli')
    : path.join(process.cwd(), 'tmp', 'cloudcli');
  const definition = readProviderSkillMarkdownDefinitionFromContent(content, 'test-skill');
  const skillName = definition.name || 'test-skill';
  const slug = `${toKebabSlug(skillName)}-${randomBytes(3).toString('hex')}`;
  const scratchPath = path.join(root, `skill-test-${slug}`);

  const result: SkillTestResult = {
    success: false,
    text: '',
    durationMs: 0,
    scratchPath,
    cleanedUp: false,
  };

  try {
    await mkdir(scratchPath, { recursive: true });

    const providerInstance = providerRegistry.resolveProvider(provider);
    const target = await providerInstance.skills.getProjectSkillTarget(scratchPath);
    if (!target) {
      result.errorMessage = `Skill testing is not supported for ${provider}`;
      return result;
    }

    const seenSkillPaths = new Set<string>();
    const install = prepareSkillInstall(
      target.rootDir,
      { content, directoryName: skillName, files: [] },
      0,
      seenSkillPaths,
    );
    await writeSkillInstall(install);

    const testPrompt = (params.testPrompt ?? '').trim();
    const prompt = testPrompt
      ? `${DEFAULT_TEST_PROMPT(skillName)}\n\n${testPrompt}`
      : DEFAULT_TEST_PROMPT(skillName);

    const created = sessionsService.createAppSession(provider, scratchPath);
    const started = await startProviderRun({
      appSessionId: created.sessionId,
      provider,
      providerSessionId: null,
      projectPath: scratchPath,
      spawnFn: getSkillTestSpawnFn(provider),
      content: prompt,
      options: {
        permissionMode: 'bypassPermissions',
        unattended: true,
      },
      connection: DETACHED_CONNECTION,
      userId: null,
    });

    if (!started.ok) {
      throw new AppError('A skill test run is already in progress for this session', {
        code: 'SKILL_TEST_RUN_IN_PROGRESS',
        statusCode: 409,
      });
    }

    await started.completion;
    const outcome = extractRunOutcome(created.sessionId);

    result.success = !outcome.failed;
    result.text = outcome.text;
    if (outcome.errorMessage) {
      result.errorMessage = outcome.errorMessage;
    }
    return result;
  } finally {
    await rm(scratchPath, { recursive: true, force: true });
    result.cleanedUp = true;
    result.durationMs = Date.now() - startedAt;
  }
}
