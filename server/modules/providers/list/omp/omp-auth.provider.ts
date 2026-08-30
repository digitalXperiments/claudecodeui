import { readFile } from 'node:fs/promises';

import spawn from 'cross-spawn';

import { ompAuthPath } from '@/modules/providers/list/omp/omp-paths.js';
import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { readObjectRecord } from '@/shared/utils.js';

// Env vars Oh My Pi recognizes for API-key auth (subset of the full catalog — enough
// for "is anything configured?" without claiming a specific provider).
const OMP_API_KEY_ENVS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'XAI_API_KEY',
  'OPENROUTER_API_KEY',
  'DEEPSEEK_API_KEY',
  'MISTRAL_API_KEY',
  'GROQ_API_KEY',
  'CEREBRAS_API_KEY',
  'AI_GATEWAY_API_KEY',
  'ZAI_API_KEY',
  'OPENCODE_API_KEY',
  'HF_TOKEN',
  'FIREWORKS_API_KEY',
  'TOGETHER_API_KEY',
  'KIMI_API_KEY',
  'MINIMAX_API_KEY',
  'XIAOMI_API_KEY',
];

export class OmpProviderAuth implements IProviderAuth {
  private checkInstalled(): boolean {
    try {
      const result = spawn.sync('omp', ['--version'], { stdio: 'ignore', timeout: 5000 });
      // ENOENT (not on PATH) surfaces as result.error; any other status means
      // the binary ran (even if it printed help and exited non-zero).
      return !result.error;
    } catch {
      return false;
    }
  }

  async getStatus(): Promise<ProviderAuthStatus> {
    const installed = this.checkInstalled();
    if (!installed) {
      return {
        installed: false,
        provider: 'omp',
        authenticated: false,
        email: null,
        method: null,
        error: 'Oh My Pi CLI is not installed. Install with: curl -fsSL https://omp.sh/install | sh',
      };
    }

    const credentials = await this.checkCredentials();
    return {
      installed: true,
      provider: 'omp',
      authenticated: credentials.authenticated,
      email: credentials.email,
      method: credentials.method,
      error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
    };
  }

  /**
   * Oh My Pi stores OAuth tokens and API keys in `~/.omp/agent/auth.json` (keyed by
   * provider name). Environment variables are an equally valid auth path.
   */
  private async checkCredentials(): Promise<{
    authenticated: boolean;
    email: string | null;
    method: string | null;
    error?: string;
  }> {
    const envProvider = OMP_API_KEY_ENVS.find((key) => {
      const value = process.env[key];
      return typeof value === 'string' && value.trim().length > 0;
    });
    if (envProvider) {
      return {
        authenticated: true,
        email: envProvider.replace(/_API_KEY$|_TOKEN$/, ''),
        method: 'api_key_env',
      };
    }

    try {
      const content = await readFile(ompAuthPath(), 'utf8');
      const parsed = readObjectRecord(JSON.parse(content)) ?? {};
      const keys = Object.keys(parsed).filter((key) => {
        const entry = parsed[key];
        if (entry == null) return false;
        if (typeof entry === 'string') return entry.trim().length > 0;
        if (typeof entry === 'object') return Object.keys(entry as object).length > 0;
        return Boolean(entry);
      });

      if (keys.length === 0) {
        return {
          authenticated: false,
          email: null,
          method: null,
          error: 'Not logged in — run `omp` and use /login, or set an API key env var',
        };
      }

      return {
        authenticated: true,
        email: keys.join(', '),
        method: 'auth_file',
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        authenticated: false,
        email: null,
        method: null,
        error: code === 'ENOENT'
          ? 'Not logged in — run `omp` and use /login, or set an API key env var'
          : error instanceof Error ? error.message : 'Failed to read Oh My Pi auth',
      };
    }
  }
}
