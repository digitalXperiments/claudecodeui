import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import spawn from 'cross-spawn';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { LLMProvider, ProviderAuthStatus } from '@/shared/types.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

type OpenCodeCredentialsStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

const OPENCODE_ENV_CREDENTIAL_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
];

export type OpenCodeProviderAuthOptions = {
  provider?: LLMProvider;
  command?: string;
  authPath?: string;
  environmentCredentialKeys?: string[];
  displayName?: string;
  notConfiguredMessage?: string;
};

export class OpenCodeProviderAuth implements IProviderAuth {
  private readonly provider: LLMProvider;
  private readonly command: string;
  private readonly authPath: string;
  private readonly environmentCredentialKeys: string[];
  private readonly displayName: string;
  private readonly notConfiguredMessage: string;

  constructor(options: OpenCodeProviderAuthOptions = {}) {
    this.provider = options.provider ?? 'opencode';
    this.command = options.command ?? 'opencode';
    this.authPath = options.authPath
      ?? path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');
    this.environmentCredentialKeys = options.environmentCredentialKeys ?? OPENCODE_ENV_CREDENTIAL_KEYS;
    this.displayName = options.displayName ?? 'OpenCode';
    this.notConfiguredMessage = options.notConfiguredMessage ?? `${this.displayName} not configured`;
  }

  /**
   * Checks whether the OpenCode CLI is available to the server process.
   */
  private checkInstalled(): boolean {
    try {
      const result = spawn.sync(this.command, ['--version'], { stdio: 'ignore', timeout: 5000 });
      return !result.error && result.status === 0;
    } catch {
      return false;
    }
  }

  /**
   * Returns OpenCode CLI installation and credential status.
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    const installed = this.checkInstalled();
    const credentials = await this.checkCredentials();

    return {
      installed,
      provider: this.provider,
      authenticated: credentials.authenticated,
      email: credentials.email,
      method: credentials.method,
      error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
    };
  }

  /**
   * Reads OpenCode's auth store or falls back to provider API key environment variables.
   */
  private async checkCredentials(): Promise<OpenCodeCredentialsStatus> {
    try {
      const content = await readFile(this.authPath, 'utf8');
      const auth = readObjectRecord(JSON.parse(content)) ?? {};

      for (const [providerId, providerAuth] of Object.entries(auth)) {
        const providerRecord = readObjectRecord(providerAuth);
        if (!providerRecord) {
          continue;
        }

        const hasCredential = Object.values(providerRecord).some(
          (value) => readOptionalString(value) !== undefined || Boolean(readObjectRecord(value)),
        );
        if (hasCredential) {
          return {
            authenticated: true,
            email: `${providerId} credentials`,
            method: 'credentials_file',
          };
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        return {
          authenticated: false,
          email: null,
          method: null,
          error: error instanceof Error ? error.message : `Failed to read ${this.displayName} auth`,
        };
      }
    }

    const envCredential = this.environmentCredentialKeys.find((key) => process.env[key]?.trim());
    if (envCredential) {
      return {
        authenticated: true,
        email: envCredential,
        method: 'environment',
      };
    }

    return {
      authenticated: false,
      email: null,
      method: null,
      error: this.notConfiguredMessage,
    };
  }
}
