import { ClaudeProvider } from '@/modules/providers/list/claude/claude.provider.js';
import { CodexProvider } from '@/modules/providers/list/codex/codex.provider.js';
import { CursorProvider } from '@/modules/providers/list/cursor/cursor.provider.js';
import { OpenCodeProvider } from '@/modules/providers/list/opencode/opencode.provider.js';
import { KiloProvider } from '@/modules/providers/list/kilo/kilo.provider.js';
import { ClineProvider } from '@/modules/providers/list/cline/cline.provider.js';
import { GrokProvider } from '@/modules/providers/list/grok/grok.provider.js';
import { KimiProvider } from '@/modules/providers/list/kimi/kimi.provider.js';
import { QwenCodeProvider } from '@/modules/providers/list/qwencode/qwencode.provider.js';
import { PiProvider } from '@/modules/providers/list/pi/pi.provider.js';
import type { IProvider } from '@/shared/interfaces.js';
import type { LLMProvider } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

const providers: Record<LLMProvider, IProvider> = {
  claude: new ClaudeProvider(),
  codex: new CodexProvider(),
  cursor: new CursorProvider(),
  opencode: new OpenCodeProvider(),
  kilo: new KiloProvider(),
  cline: new ClineProvider(),
  grok: new GrokProvider(),
  kimi: new KimiProvider(),
  qwencode: new QwenCodeProvider(),
  pi: new PiProvider(),
};

/**
 * Central registry for resolving concrete provider implementations by id.
 */
export const providerRegistry = {
  listProviders(): IProvider[] {
    return Object.values(providers);
  },

  resolveProvider(provider: string): IProvider {
    const key = provider as LLMProvider;
    const resolvedProvider = providers[key];
    if (!resolvedProvider) {
      throw new AppError(`Unsupported provider "${provider}".`, {
        code: 'UNSUPPORTED_PROVIDER',
        statusCode: 400,
      });
    }

    return resolvedProvider;
  },
};
