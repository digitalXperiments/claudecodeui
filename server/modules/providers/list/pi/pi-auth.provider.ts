import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import spawn from 'cross-spawn';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { readObjectRecord } from '@/shared/utils.js';

const PI_AUTH_PATH = path.join(os.homedir(), '.pi', 'agent', 'auth.json');

// Env vars Pi recognizes for API-key auth (subset of the full catalog — enough
// for "is anything configured?" without claiming a specific provider).
const PI_API_KEY_ENVS = [
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

export class PiProviderAuth implements IProviderAuth {
  private checkInstalled(): boolean {
    try {
      const result = spawn.sync('pi', ['--version'], { stdio: 'ignore', timeout: 5000 });
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
        provider: 'pi',
        authenticated: false,
        email: null,
        method: null,
        error: 'Pi CLI is not installed. Install with: npm install -g --ignore-scripts @earendil-works/pi-coding-agent',
      };
    }

    const credentials = await this.checkCredentials();
    return {
      installed: true,
      provider: 'pi',
      authenticated: credentials.authenticated,
      email: credentials.email,
      method: credentials.method,
      error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
    };
  }

  /**
   * Pi stores OAuth tokens and API keys in `~/.pi/agent/auth.json` (keyed by
   * provider name). Environment variables are an equally valid auth path.
   */
  private async checkCredentials(): Promise<{
    authenticated: boolean;
    email: string | null;
    method: string | null;
    error?: string;
  }> {
    const envProvider = PI_API_KEY_ENVS.find((key) => {
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
      const content = await readFile(PI_AUTH_PATH, 'utf8');
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
          error: 'Not logged in — run `pi` and use /login, or set an API key env var',
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
          ? 'Not logged in — run `pi` and use /login, or set an API key env var'
          : error instanceof Error ? error.message : 'Failed to read Pi auth',
      };
    }
  }
}
