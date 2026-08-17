import path from 'node:path';

import {
  OpenCodeProviderAuth,
  type OpenCodeProviderAuthOptions,
} from '@/modules/providers/list/opencode/opencode-auth.provider.js';
import { getKiloDataDirectory } from '@/shared/utils.js';

const KILO_AUTH_OPTIONS: OpenCodeProviderAuthOptions = {
  provider: 'kilo',
  command: 'kilo',
  authPath: path.join(getKiloDataDirectory(), 'auth.json'),
  environmentCredentialKeys: [
    'KILO_API_KEY',
    'KILOCODE_API_KEY',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
  ],
  displayName: 'Kilo Code',
  notConfiguredMessage: 'Kilo Code is not configured. Run `kilo auth login` or set KILO_API_KEY.',
};

/** Kilo Code's auth store is separate from OpenCode's despite the shared ACP shape. */
export class KiloProviderAuth extends OpenCodeProviderAuth {
  constructor() {
    super(KILO_AUTH_OPTIONS);
  }
}
