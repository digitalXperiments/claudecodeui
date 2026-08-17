import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import spawn from 'cross-spawn';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { readObjectRecord } from '@/shared/utils.js';

const QWEN_ENV_KEYS = [
  'OPENAI_API_KEY', 'DASHSCOPE_API_KEY', 'BAILIAN_CODING_PLAN_API_KEY',
  'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'QWEN_API_KEY',
];

export class QwenCodeProviderAuth implements IProviderAuth {
  private checkInstalled(): boolean {
    try {
      const result = spawn.sync('qwen', ['--version'], { stdio: 'ignore', timeout: 5000 });
      return !result.error && result.status === 0;
    } catch { return false; }
  }

  async getStatus(): Promise<ProviderAuthStatus> {
    const credentials = await this.readCredentials();
    return {
      installed: this.checkInstalled(), provider: 'qwencode',
      authenticated: credentials.authenticated,
      email: credentials.email, method: credentials.method,
      error: credentials.authenticated ? undefined : 'Qwen Code is not authenticated',
    };
  }

  private async readCredentials(): Promise<{ authenticated: boolean; email: string | null; method: string | null }> {
    const envKey = QWEN_ENV_KEYS.find((key) => process.env[key]?.trim());
    if (envKey) return { authenticated: true, email: envKey, method: 'environment' };

    try {
      const raw = readObjectRecord(JSON.parse(await readFile(path.join(os.homedir(), '.qwen', 'oauth_creds.json'), 'utf8')));
      if (raw && ['access_token', 'refresh_token', 'accessToken', 'refreshToken'].some((key) => typeof raw[key] === 'string' && raw[key])) {
        return { authenticated: true, email: 'Authenticated', method: 'oauth' };
      }
    } catch { /* not logged in or OAuth file is absent */ }

    return { authenticated: false, email: null, method: null };
  }
}
