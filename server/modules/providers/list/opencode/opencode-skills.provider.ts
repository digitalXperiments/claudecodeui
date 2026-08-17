import os from 'node:os';
import path from 'node:path';

import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { LLMProvider, ProviderSkillSource } from '@/shared/types.js';
import {
  addUniqueProviderSkillSource,
  findTopmostGitRoot,
} from '@/shared/utils.js';

const OPENCODE_PROJECT_SKILL_DIRS = [
  ['.opencode', 'skills'],
  ['.claude', 'skills'],
  ['.agents', 'skills'],
];

const OPENCODE_USER_SKILL_DIRS = [
  ['.config', 'opencode', 'skills'],
  ['.claude', 'skills'],
  ['.agents', 'skills'],
];

export type OpenCodeSkillsProviderOptions = {
  provider?: LLMProvider;
  projectSkillDirs?: string[][];
  userSkillDirs?: string[][];
};

export class OpenCodeSkillsProvider extends SkillsProvider {
  private readonly projectSkillDirs: string[][];
  private readonly userSkillDirs: string[][];

  constructor(options: OpenCodeSkillsProviderOptions = {}) {
    super(options.provider ?? 'opencode');
    this.projectSkillDirs = options.projectSkillDirs ?? OPENCODE_PROJECT_SKILL_DIRS;
    this.userSkillDirs = options.userSkillDirs ?? OPENCODE_USER_SKILL_DIRS;
  }

  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    const sources: ProviderSkillSource[] = [];
    const seenRootDirs = new Set<string>();
    const repoRoot = await findTopmostGitRoot(workspacePath);

    for (const projectRoot of this.getProjectSearchRoots(workspacePath, repoRoot)) {
      for (const skillDir of this.projectSkillDirs) {
        // OpenCode intentionally reads Claude and Agents skill folders so users
        // can reuse the same skill libraries across compatible coding agents.
        addUniqueProviderSkillSource(sources, seenRootDirs, {
          scope: 'project',
          rootDir: path.join(projectRoot, ...skillDir),
          commandPrefix: '/',
        });
      }
    }

    for (const skillDir of this.userSkillDirs) {
      addUniqueProviderSkillSource(sources, seenRootDirs, {
        scope: 'user',
        rootDir: path.join(os.homedir(), ...skillDir),
        commandPrefix: '/',
      });
    }

    return sources;
  }

  private getProjectSearchRoots(workspacePath: string, repoRoot: string | null): string[] {
    const roots: string[] = [];
    const normalizedWorkspacePath = path.resolve(workspacePath);
    const normalizedRepoRoot = repoRoot ? path.resolve(repoRoot) : null;
    let currentPath = normalizedWorkspacePath;

    while (true) {
      roots.push(currentPath);
      if (!normalizedRepoRoot || currentPath === normalizedRepoRoot) {
        break;
      }

      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        break;
      }

      currentPath = parentPath;
    }

    return roots;
  }
}
