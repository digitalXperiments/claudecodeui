import os from 'node:os';
import path from 'node:path';

import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkillSource } from '@/shared/types.js';

/**
 * Antigravity skill discovery roots, in precedence order:
 *
 *   .gemini/skills  →  .agents/skills  →  .agent/skills
 *
 * `.gemini` is Antigravity's own namespace and wins; `.agents` is the
 * cross-agent convention Codex/Oh My Pi already read; `.agent` (singular) is
 * the older spelling some repos still carry. Project roots are listed before
 * user roots so a repo-local skill shadows a personal one of the same name.
 */
const SKILL_DIRECTORIES = ['.gemini', '.agents', '.agent'] as const;

export class AntigravitySkillsProvider extends SkillsProvider {
  constructor() {
    super('antigravity');
  }

  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    const sources: ProviderSkillSource[] = [];
    for (const directory of SKILL_DIRECTORIES) {
      sources.push({
        scope: 'project',
        rootDir: path.join(workspacePath, directory, 'skills'),
        commandPrefix: '/',
      });
    }
    for (const directory of SKILL_DIRECTORIES) {
      sources.push({
        scope: 'user',
        rootDir: path.join(os.homedir(), directory, 'skills'),
        commandPrefix: '/',
      });
    }
    return sources;
  }

  protected async getGlobalSkillSource(): Promise<ProviderSkillSource> {
    return {
      scope: 'user',
      rootDir: path.join(os.homedir(), '.gemini', 'skills'),
      commandPrefix: '/',
    };
  }

  async getProjectSkillTarget(workspacePath: string): Promise<ProviderSkillSource> {
    return {
      scope: 'project',
      rootDir: path.join(workspacePath, '.gemini', 'skills'),
      commandPrefix: '/',
    };
  }
}
