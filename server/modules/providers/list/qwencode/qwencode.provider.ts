import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import { QwenCodeProviderAuth } from './qwencode-auth.provider.js';
import { QwenCodeProviderModels } from './qwencode-models.provider.js';
import { QwenCodeMcpProvider } from './qwencode-mcp.provider.js';
import { QwenCodeSessionSynchronizer } from './qwencode-session-synchronizer.provider.js';
import { QwenCodeSessionsProvider } from './qwencode-sessions.provider.js';
import { QwenCodeSkillsProvider } from './qwencode-skills.provider.js';
import type { IProviderAuth, IProviderModels, IProviderMcp, IProviderSessionSynchronizer, IProviderSkills, IProviderSessions } from '@/shared/interfaces.js';

export class QwenCodeProvider extends AbstractProvider {
  readonly models: IProviderModels = new QwenCodeProviderModels();
  readonly mcp: IProviderMcp = new QwenCodeMcpProvider();
  readonly auth: IProviderAuth = new QwenCodeProviderAuth();
  readonly skills: IProviderSkills = new QwenCodeSkillsProvider();
  readonly sessions: IProviderSessions = new QwenCodeSessionsProvider();
  readonly sessionSynchronizer: IProviderSessionSynchronizer = new QwenCodeSessionSynchronizer();
  constructor() { super('qwencode'); }
}
