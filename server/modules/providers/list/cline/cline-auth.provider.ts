import path from 'node:path';

import {
  OpenCodeProviderAuth,
  type OpenCodeProviderAuthOptions,
} from '@/modules/providers/list/opencode/opencode-auth.provider.js';
import { getClineDataDirectory } from '@/shared/utils.js';

const CLINE_AUTH_OPTIONS: OpenCodeProviderAuthOptions = {
  provider: 'cline',
  command: 'cline',
  authPath: path.join(getClineDataDirectory(), 'settings', 'providers.json'),
  environmentCredentialKeys: [
    'CLINE_API_KEY',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
  ],
  displayName: 'Cline',
  notConfiguredMessage: 'Cline is not configured. Run `cline auth` or set CLINE_API_KEY.',
};

export class ClineProviderAuth extends OpenCodeProviderAuth {
  constructor() {
    super(CLINE_AUTH_OPTIONS);
  }
}
