import os from 'node:os';
import path from 'node:path';

import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkillSource } from '@/shared/types.js';
import { getClineDataDirectory } from '@/shared/utils.js';

export class ClineSkillsProvider extends SkillsProvider {
  constructor() { super('cline'); }

  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    return [
      { scope: 'project', rootDir: path.join(workspacePath, '.cline', 'skills'), commandPrefix: '/' },
      { scope: 'user', rootDir: path.join(getClineDataDirectory(), 'skills'), commandPrefix: '/' },
      { scope: 'user', rootDir: path.join(os.homedir(), '.cline', 'skills'), commandPrefix: '/' },
    ];
  }

  protected async getGlobalSkillSource(): Promise<ProviderSkillSource> {
    return { scope: 'user', rootDir: path.join(getClineDataDirectory(), 'skills'), commandPrefix: '/' };
  }
}
