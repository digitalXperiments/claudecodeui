import os from 'node:os';
import path from 'node:path';

import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkillSource } from '@/shared/types.js';

/**
 * Pi skill discovery roots (from pi docs/skills.md):
 * - `~/.pi/agent/skills/`, `~/.agents/skills/`
 * - `.pi/skills/`, `.agents/skills/` (cwd and parents)
 * Skills are invoked as `/skill:name`.
 */
export class PiSkillsProvider extends SkillsProvider {
  constructor() {
    super('pi');
  }

  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    return [
      {
        scope: 'project',
        rootDir: path.join(workspacePath, '.pi', 'skills'),
        commandPrefix: '/',
      },
      {
        scope: 'project',
        rootDir: path.join(workspacePath, '.agents', 'skills'),
        commandPrefix: '/',
      },
      {
        scope: 'user',
        rootDir: path.join(os.homedir(), '.pi', 'agent', 'skills'),
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
      rootDir: path.join(os.homedir(), '.pi', 'agent', 'skills'),
      commandPrefix: '/',
    };
  }

  async getProjectSkillTarget(workspacePath: string): Promise<ProviderSkillSource> {
    return {
      scope: 'project',
      rootDir: path.join(workspacePath, '.pi', 'skills'),
      commandPrefix: '/',
    };
  }
}
