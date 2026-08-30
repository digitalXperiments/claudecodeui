import os from 'node:os';
import path from 'node:path';

import { ompSkillsRoot } from '@/modules/providers/list/omp/omp-paths.js';
import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkillSource } from '@/shared/types.js';

/**
 * Oh My Pi skill discovery roots (Pi's layout, retargeted to OMP's own home so
 * we never read or write Pi's `~/.pi`):
 * - `~/.omp/skills/` (or `~/.omp/agent/skills/`), `~/.agents/skills/`
 * - `.omp/skills/`, `.agents/skills/` (cwd and parents)
 * Skills are invoked as `/skill:name`.
 */
export class OmpSkillsProvider extends SkillsProvider {
  constructor() {
    super('omp');
  }

  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    return [
      {
        scope: 'project',
        rootDir: path.join(workspacePath, '.omp', 'skills'),
        commandPrefix: '/',
      },
      {
        scope: 'project',
        rootDir: path.join(workspacePath, '.agents', 'skills'),
        commandPrefix: '/',
      },
      {
        scope: 'user',
        rootDir: ompSkillsRoot(),
        commandPrefix: '/',
      },
      {
        scope: 'user',
        rootDir: path.join(os.homedir(), '.agents', 'skills'),
        commandPrefix: '/',
      },
    ];
  }

  protected async getGlobalSkillSource(): Promise<ProviderSkillSource> {
    return {
      scope: 'user',
      rootDir: ompSkillsRoot(),
      commandPrefix: '/',
    };
  }

  async getProjectSkillTarget(workspacePath: string): Promise<ProviderSkillSource> {
    return {
      scope: 'project',
      rootDir: path.join(workspacePath, '.omp', 'skills'),
      commandPrefix: '/',
    };
  }
}
