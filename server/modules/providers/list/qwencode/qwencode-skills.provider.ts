import os from 'node:os';
import path from 'node:path';
import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkillSource } from '@/shared/types.js';

export class QwenCodeSkillsProvider extends SkillsProvider {
  constructor() { super('qwencode'); }
  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    return [
      { scope: 'project', rootDir: path.join(workspacePath, '.qwen', 'skills'), commandPrefix: '/' },
      { scope: 'user', rootDir: path.join(os.homedir(), '.qwen', 'skills'), commandPrefix: '/' },
    ];
  }
  protected async getGlobalSkillSource(): Promise<ProviderSkillSource> {
    return { scope: 'user', rootDir: path.join(os.homedir(), '.qwen', 'skills'), commandPrefix: '/' };
  }
  async getProjectSkillTarget(workspacePath: string): Promise<ProviderSkillSource> {
    return { scope: 'project', rootDir: path.join(workspacePath, '.qwen', 'skills'), commandPrefix: '/' };
  }
}
