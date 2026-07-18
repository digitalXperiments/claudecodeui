import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import spawn from 'cross-spawn';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

type GrokCredentialsStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

export class GrokProviderAuth implements IProviderAuth {
  /**
   * Checks whether the grok CLI is available on this host.
   */
  private checkInstalled(): boolean {
    try {
      spawn.sync('grok', ['--version'], { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Returns Grok CLI installation and login status.
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    const installed = this.checkInstalled();
    const credentials = await this.checkCredentials();

    return {
      installed,
      provider: 'grok',
      authenticated: credentials.authenticated,
      email: credentials.email,
      method: credentials.method,
      error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
    };
  }

  /**
   * Reads ~/.grok/auth.json and checks for a non-expired credential entry.
   *
   * auth.json is keyed by `<issuer>::<uuid>` rather than a fixed field name, so
   * every entry is scanned for the newest non-expired token.
   */
  private async checkCredentials(): Promise<GrokCredentialsStatus> {
    try {
      const authPath = path.join(os.homedir(), '.grok', 'auth.json');
      const content = await readFile(authPath, 'utf8');
      const auth = readObjectRecord(JSON.parse(content)) ?? {};

      let best: { email: string | null; expiresAt: number } | null = null;

      for (const rawEntry of Object.values(auth)) {
        const entry = readObjectRecord(rawEntry);
        if (!entry) {
          continue;
        }

        const expiresAt = typeof entry.expires_at === 'number' ? entry.expires_at : Number(entry.expires_at);
        if (Number.isFinite(expiresAt) && expiresAt * 1000 < Date.now()) {
          continue;
        }

        const email = readOptionalString(entry.email) ?? null;
        if (!best || (Number.isFinite(expiresAt) && expiresAt > best.expiresAt)) {
          best = { email, expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0 };
        }
      }

      if (best) {
        return { authenticated: true, email: best.email ?? 'Authenticated', method: 'oauth' };
      }

      return { authenticated: false, email: null, method: null, error: 'Not logged in' };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        authenticated: false,
        email: null,
        method: null,
        error: code === 'ENOENT' ? 'Grok not configured' : error instanceof Error ? error.message : 'Failed to read Grok auth',
      };
    }
  }
}
