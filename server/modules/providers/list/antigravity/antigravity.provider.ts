import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import type {
  IProviderAuth,
  IProviderMcp,
  IProviderModels,
  IProviderSessionSynchronizer,
  IProviderSessions,
  IProviderSkills,
} from '@/shared/interfaces.js';

import { AntigravityProviderAuth } from './antigravity-auth.provider.js';
import { AntigravityMcpProvider } from './antigravity-mcp.provider.js';
import { AntigravityProviderModels } from './antigravity-models.provider.js';
import { AntigravitySessionSynchronizer } from './antigravity-session-synchronizer.provider.js';
import { AntigravitySessionsProvider } from './antigravity-sessions.provider.js';
import { AntigravitySkillsProvider } from './antigravity-skills.provider.js';

/** Google Antigravity, driven through its official ACP agent (T3 Code's approach). */
export class AntigravityProvider extends AbstractProvider {
  readonly models: IProviderModels = new AntigravityProviderModels();
  readonly mcp: IProviderMcp = new AntigravityMcpProvider();
  readonly auth: IProviderAuth = new AntigravityProviderAuth();
  readonly skills: IProviderSkills = new AntigravitySkillsProvider();
  readonly sessions: IProviderSessions = new AntigravitySessionsProvider();
  readonly sessionSynchronizer: IProviderSessionSynchronizer = new AntigravitySessionSynchronizer();

  constructor() {
    super('antigravity');
  }
}
