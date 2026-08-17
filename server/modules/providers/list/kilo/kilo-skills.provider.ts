import {
  OpenCodeSkillsProvider,
  type OpenCodeSkillsProviderOptions,
} from '@/modules/providers/list/opencode/opencode-skills.provider.js';

const KILO_SKILL_OPTIONS: OpenCodeSkillsProviderOptions = {
  provider: 'kilo',
  // Kilo's canonical project roots are .kilo/skill(s); .kilocode/skills is
  // retained because existing Kilo projects still use the legacy spelling.
  projectSkillDirs: [
    ['.kilo', 'skills'],
    ['.kilo', 'skill'],
    ['.kilocode', 'skills'],
  ],
  userSkillDirs: [
    ['.config', 'kilo', 'skills'],
    ['.kilocode', 'skills'],
    ['.kilo', 'skills'],
  ],
};

export class KiloSkillsProvider extends OpenCodeSkillsProvider {
  constructor() {
    super(KILO_SKILL_OPTIONS);
  }
}
