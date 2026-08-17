import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import { ClineProviderAuth } from '@/modules/providers/list/cline/cline-auth.provider.js';
import { ClineMcpProvider } from '@/modules/providers/list/cline/cline-mcp.provider.js';
import { ClineProviderModels } from '@/modules/providers/list/cline/cline-models.provider.js';
import { ClineSessionSynchronizer } from '@/modules/providers/list/cline/cline-session-synchronizer.provider.js';
import { ClineSessionsProvider } from '@/modules/providers/list/cline/cline-sessions.provider.js';
import { ClineSkillsProvider } from '@/modules/providers/list/cline/cline-skills.provider.js';
import type {
  IProviderAuth,
  IProviderModels,
  IProviderSessionSynchronizer,
  IProviderSkills,
  IProviderSessions,
} from '@/shared/interfaces.js';

export class ClineProvider extends AbstractProvider {
  readonly models: IProviderModels = new ClineProviderModels();
  readonly mcp = new ClineMcpProvider();
  readonly auth: IProviderAuth = new ClineProviderAuth();
  readonly skills: IProviderSkills = new ClineSkillsProvider();
  readonly sessions: IProviderSessions = new ClineSessionsProvider();
  readonly sessionSynchronizer: IProviderSessionSynchronizer = new ClineSessionSynchronizer();

  constructor() {
    super('cline');
  }
}
