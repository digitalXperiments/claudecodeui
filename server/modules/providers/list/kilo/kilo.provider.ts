import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import { KiloProviderAuth } from '@/modules/providers/list/kilo/kilo-auth.provider.js';
import { KiloMcpProvider } from '@/modules/providers/list/kilo/kilo-mcp.provider.js';
import { KiloProviderModels } from '@/modules/providers/list/kilo/kilo-models.provider.js';
import { KiloSessionSynchronizer } from '@/modules/providers/list/kilo/kilo-session-synchronizer.provider.js';
import { KiloSessionsProvider } from '@/modules/providers/list/kilo/kilo-sessions.provider.js';
import { KiloSkillsProvider } from '@/modules/providers/list/kilo/kilo-skills.provider.js';
import type {
  IProviderAuth,
  IProviderModels,
  IProviderSessionSynchronizer,
  IProviderSkills,
  IProviderSessions,
} from '@/shared/interfaces.js';

export class KiloProvider extends AbstractProvider {
  readonly models: IProviderModels = new KiloProviderModels();
  readonly mcp = new KiloMcpProvider();
  readonly auth: IProviderAuth = new KiloProviderAuth();
  readonly skills: IProviderSkills = new KiloSkillsProvider();
  readonly sessions: IProviderSessions = new KiloSessionsProvider();
  readonly sessionSynchronizer: IProviderSessionSynchronizer = new KiloSessionSynchronizer();

  constructor() {
    super('kilo');
  }
}
