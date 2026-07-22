import os from 'node:os';
import path from 'node:path';

import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkillSource } from '@/shared/types.js';

export class AgySkillsProvider extends SkillsProvider {
  constructor() {
    super('agy');
  }

  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    return [
      {
        scope: 'project',
        rootDir: path.join(workspacePath, '.gemini', 'skills'),
        commandPrefix: '/',
      },
      {
        scope: 'project',
        rootDir: path.join(workspacePath, '.agents', 'skills'),
        commandPrefix: '/',
      },
      {
        scope: 'user',
        rootDir: path.join(os.homedir(), '.gemini', 'antigravity-cli', 'skills'),
        commandPrefix: '/',
      },
      {
        scope: 'user',
        rootDir: path.join(os.homedir(), '.gemini', 'config', 'skills'),
        commandPrefix: '/',
      },
    ];
  }

  protected async getGlobalSkillSource(): Promise<ProviderSkillSource> {
    return {
      scope: 'user',
      rootDir: path.join(os.homedir(), '.gemini', 'antigravity-cli', 'skills'),
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

