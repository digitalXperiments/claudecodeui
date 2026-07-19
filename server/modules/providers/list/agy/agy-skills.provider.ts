import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkillSource } from '@/shared/types.js';

/**
 * Antigravity CLI skills are not exposed by this lean provider (its skills
 * layout is not part of the integration). Returning no sources leaves the
 * skills list empty for `agy` without breaking the shared skills contract.
 */
export class AgySkillsProvider extends SkillsProvider {
  constructor() {
    super('agy');
  }

  protected async getSkillSources(_workspacePath: string): Promise<ProviderSkillSource[]> {
    return [];
  }

  protected async getGlobalSkillSource(): Promise<ProviderSkillSource | null> {
    return null;
  }
}
