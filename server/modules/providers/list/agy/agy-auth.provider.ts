import { readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import spawn from 'cross-spawn';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

const AGY_DATA_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli');
const AGY_TOKEN_PATH = path.join(AGY_DATA_DIR, 'antigravity-oauth-token');
const AGY_LOG_DIR = path.join(AGY_DATA_DIR, 'log');

type AgyCredentialsStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

export class AgyProviderAuth implements IProviderAuth {
  /**
   * Checks whether the `agy` (Antigravity) CLI is available on this host.
   */
  private checkInstalled(): boolean {
    try {
      spawn.sync('agy', ['--help'], { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Returns Antigravity CLI installation and login status.
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    const installed = this.checkInstalled();
    const credentials = await this.checkCredentials();

    return {
      installed,
      provider: 'agy',
      authenticated: credentials.authenticated,
      email: credentials.email,
      method: credentials.method,
      error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
    };
  }

  /**
   * Antigravity stores its OAuth credential at
   * `~/.gemini/antigravity-cli/antigravity-oauth-token` as
   * `{ token: { access_token, ... }, auth_method }` (the `token` field is a
   * nested OAuth object, not a bare string). The file carries no email, so the
   * signed-in address is recovered best-effort from the newest CLI log's
   * `applyAuthResult: email=<addr>` line.
   */
  private async checkCredentials(): Promise<AgyCredentialsStatus> {
    let authMethod: string | null = null;
    try {
      const content = await readFile(AGY_TOKEN_PATH, 'utf8');
      const parsed = readObjectRecord(JSON.parse(content)) ?? {};
      const tokenRecord = readObjectRecord(parsed.token);
      const accessToken = readOptionalString(tokenRecord?.access_token);
      // Accept either the nested `{ token: { access_token } }` shape or a bare
      // string token, so a future credential format still reports correctly.
      const hasToken = Boolean(accessToken) || Boolean(readOptionalString(parsed.token));
      if (!hasToken) {
        return { authenticated: false, email: null, method: null, error: 'Not logged in' };
      }
      authMethod = readOptionalString(parsed.auth_method) ?? 'oauth';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        authenticated: false,
        email: null,
        method: null,
        error: code === 'ENOENT' ? 'Antigravity not configured' : error instanceof Error ? error.message : 'Failed to read Antigravity auth',
      };
    }

    const email = await this.resolveEmailFromLogs();
    return { authenticated: true, email: email ?? 'Authenticated', method: authMethod };
  }

  private async resolveEmailFromLogs(): Promise<string | null> {
    try {
      const entries = await readdir(AGY_LOG_DIR);
      const logs = entries
        .filter((name) => name.startsWith('cli-') && name.endsWith('.log'))
        .sort()
        .reverse();

      for (const name of logs.slice(0, 5)) {
        const content = await readFile(path.join(AGY_LOG_DIR, name), 'utf8');
        const match = content.match(/applyAuthResult:\s*email=([^\s,]+)/);
        if (match?.[1]) {
          return match[1];
        }
      }
    } catch {
      // Logs are best-effort; absence just means we report "Authenticated".
    }
    return null;
  }
}
