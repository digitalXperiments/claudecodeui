import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import spawn from 'cross-spawn';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

type KimiCredentialsStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

export class KimiProviderAuth implements IProviderAuth {
  /**
   * Checks whether the kimi CLI is available on this host.
   */
  private checkInstalled(): boolean {
    try {
      spawn.sync('kimi', ['--version'], { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Returns Kimi Code CLI installation and login status.
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    const installed = this.checkInstalled();
    const credentials = await this.checkCredentials();

    return {
      installed,
      provider: 'kimi',
      authenticated: credentials.authenticated,
      email: credentials.email,
      method: credentials.method,
      error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
    };
  }

  /**
   * Reads ~/.kimi-code/credentials/kimi-code.json.
   *
   * The `access_token` is short-lived (~15 min, per `expires_in`); the CLI
   * transparently refreshes it on every invocation using `refresh_token`, so
   * presence of a non-expired refresh_token — not the access token's own
   * `expires_at` — is the correct "still logged in" signal. The refresh
   * token's own lifetime isn't exposed as a top-level field here, so we treat
   * a non-empty string as valid and let `kimi doctor`/an actual CLI call
   * surface the rare case where the refresh token itself has expired.
   */
  private async checkCredentials(): Promise<KimiCredentialsStatus> {
    try {
      const credentialsPath = path.join(os.homedir(), '.kimi-code', 'credentials', 'kimi-code.json');
      const content = await readFile(credentialsPath, 'utf8');
      const credentials = readObjectRecord(JSON.parse(content));
      const refreshToken = readOptionalString(credentials?.refresh_token);

      if (refreshToken) {
        return { authenticated: true, email: 'Authenticated', method: 'oauth' };
      }

      return { authenticated: false, email: null, method: null, error: 'Not logged in' };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        authenticated: false,
        email: null,
        method: null,
        error: code === 'ENOENT' ? 'Kimi not configured' : error instanceof Error ? error.message : 'Failed to read Kimi credentials',
      };
    }
  }
}
